import {
  credentials,
  Metadata,
  status as grpcStatus,
  type Server,
  type sendUnaryData,
  type ServerUnaryCall,
  type ServerWritableStream,
  type ServiceError,
} from "@grpc/grpc-js";
import {
  HealthCheckResponse_ServingStatus,
  HealthClient,
  HealthService,
  type HealthCheckRequest,
  type HealthCheckResponse,
  type HealthServer,
} from "@vidforge/proto/health";

/** The health spec's name for "the server as a whole". */
export const OVERALL = "";

export type ServingStatus = "SERVING" | "NOT_SERVING";

const WIRE_STATUS: Record<ServingStatus, HealthCheckResponse_ServingStatus> = {
  SERVING: HealthCheckResponse_ServingStatus.SERVING,
  NOT_SERVING: HealthCheckResponse_ServingStatus.NOT_SERVING,
};

export interface HealthRegistry {
  /** Pass to registerHealthService; exposed for tests. */
  readonly implementation: HealthServer;
  /** Mark the server, and every service it was created with, SERVING. */
  serve(): void;
  /** Mark everything NOT_SERVING — the first step of a drain. */
  drain(): void;
  setStatus(service: string, status: ServingStatus): void;
  getStatus(service: string): ServingStatus | undefined;
}

function notFound(service: string): ServiceError {
  const message = `unknown service "${service}"`;
  return Object.assign(new Error(message), {
    code: grpcStatus.NOT_FOUND,
    details: message,
    metadata: new Metadata(),
  }) as ServiceError;
}

/**
 * An in-memory implementation of grpc.health.v1.Health.
 *
 * Everything starts NOT_SERVING: a task that has been started but has not
 * bound its port yet is not ready for traffic, and reporting SERVING before
 * then would have the load balancer route to a dead socket.
 */
export function createHealthRegistry(services: string[] = []): HealthRegistry {
  const known = [OVERALL, ...services];
  const statuses = new Map<string, ServingStatus>(known.map((s) => [s, "NOT_SERVING"]));
  const watchers = new Map<string, Set<(status: ServingStatus) => void>>();

  function setStatus(service: string, status: ServingStatus) {
    statuses.set(service, status);
    for (const notify of watchers.get(service) ?? []) notify(status);
  }

  function setAll(status: ServingStatus) {
    for (const service of statuses.keys()) setStatus(service, status);
  }

  const implementation: HealthServer = {
    check(
      call: ServerUnaryCall<HealthCheckRequest, HealthCheckResponse>,
      callback: sendUnaryData<HealthCheckResponse>,
    ) {
      const status = statuses.get(call.request.service);
      if (status === undefined) return callback(notFound(call.request.service), null);
      callback(null, { status: WIRE_STATUS[status] });
    },

    watch(call: ServerWritableStream<HealthCheckRequest, HealthCheckResponse>) {
      const { service } = call.request;
      const send = (status: ServingStatus) => call.write({ status: WIRE_STATUS[status] });

      const current = statuses.get(service);
      // An unknown service still gets a subscription: the spec has Watch
      // report SERVICE_UNKNOWN now and the real status if it appears later.
      if (current === undefined) {
        call.write({ status: HealthCheckResponse_ServingStatus.SERVICE_UNKNOWN });
      } else {
        send(current);
      }

      const subscribers = watchers.get(service) ?? new Set();
      subscribers.add(send);
      watchers.set(service, subscribers);

      const unsubscribe = () => subscribers.delete(send);
      call.on("cancelled", unsubscribe);
      call.on("close", unsubscribe);
      call.on("error", unsubscribe);
    },
  };

  return {
    implementation,
    serve: () => setAll("SERVING"),
    drain: () => setAll("NOT_SERVING"),
    setStatus,
    getStatus: (service) => statuses.get(service),
  };
}

export function registerHealthService(server: Server, registry: HealthRegistry): void {
  server.addService(HealthService, registry.implementation);
}

/**
 * Dials a gRPC server and resolves true only if it reports SERVING. Used by
 * the container health probes; never throws, so callers can map it straight
 * to an exit code.
 */
export async function probeHealth(
  address: string,
  service: string = OVERALL,
  timeoutMs = 2_000,
): Promise<boolean> {
  const client = new HealthClient(address, credentials.createInsecure());
  try {
    const response = await new Promise<HealthCheckResponse>((resolve, reject) => {
      client.check(
        { service },
        new Metadata(),
        { deadline: Date.now() + timeoutMs },
        (err, res) => (err ? reject(err) : resolve(res)),
      );
    });
    return response.status === HealthCheckResponse_ServingStatus.SERVING;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

/**
 * Entrypoint for the container HEALTHCHECK: `tsx src/healthcheck.ts [address]`.
 * Exits 0 when the server reports SERVING, 1 otherwise.
 */
export async function runHealthProbe(defaultAddress: string): Promise<void> {
  const address = process.argv[2] ?? defaultAddress;
  const healthy = await probeHealth(address);
  if (!healthy) console.error(`health probe failed for ${address}`);
  process.exit(healthy ? 0 : 1);
}

/**
 * Drains on SIGTERM/SIGINT: report NOT_SERVING so the platform stops routing
 * to this task, let in-flight RPCs finish, then exit.
 *
 * graceMs must stay under the platform's stop timeout (ECS `stopTimeout`,
 * compose `stop_grace_period`) so the process exits on its own terms rather
 * than being SIGKILLed mid-RPC.
 */
export function drainOnSignals(
  server: Server,
  registry: HealthRegistry,
  opts: { graceMs?: number; onDrain?: () => Promise<void> | void } = {},
): void {
  const graceMs = opts.graceMs ?? Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000);
  let draining = false;

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (draining) return;
      draining = true;
      console.log(`${signal} received, draining`);
      registry.drain();

      const force = setTimeout(() => {
        console.error(`drain exceeded ${graceMs}ms, forcing shutdown`);
        server.forceShutdown();
        process.exit(1);
      }, graceMs);
      force.unref();

      server.tryShutdown(async (err) => {
        if (err) console.error(`tryShutdown failed: ${err.message}`);
        try {
          await opts.onDrain?.();
        } catch (drainErr) {
          console.error("onDrain failed:", drainErr);
        }
        clearTimeout(force);
        process.exit(err ? 1 : 0);
      });
    });
  }
}
