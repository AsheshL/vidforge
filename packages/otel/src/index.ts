import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { GrpcInstrumentation } from "@opentelemetry/instrumentation-grpc";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// The ADOT collector sidecar's usual address inside an ECS task: Fargate
// `awsvpc` mode puts every container in one task on the same network
// namespace, so "localhost" here means "the sidecar", not "this container".
// Locally (no sidecar) this just fails to connect, which OTLPTraceExporter
// handles as a background export failure — see startTracing below.
const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318";

/**
 * Attribute key used to correlate a span with VidForge's own
 * `RequestContext.traceId` (see `packages/svc-auth`). Real distributed
 * trace-context propagation across the gRPC boundary isn't wired up yet —
 * `@opentelemetry/instrumentation-grpc` gives parent/child linkage for calls
 * made *through* an instrumented gRPC client/server in the same process
 * tree, but our own `RequestContext.traceId` is the thing that actually
 * flows from the gateway through every downstream service today, so we tag
 * it onto every span as well. That way traces from one request can be found
 * by the same id even where the two propagation mechanisms diverge.
 */
export const TRACE_ID_ATTRIBUTE = "vidforge.trace_id";

export interface TracingHandle {
  /** Flushes and stops the SDK. Safe to call more than once. */
  shutdown(): Promise<void>;
}

/**
 * Starts the OpenTelemetry Node SDK for a service, exporting spans over
 * OTLP/HTTP (matching the protocol `apps/web`'s `@vercel/otel` integration
 * uses, so every service in the fleet speaks the same wire format to the
 * ADOT collector sidecar) to `OTEL_EXPORTER_OTLP_ENDPOINT` — defaulting to
 * the sidecar's usual localhost address so local dev without a collector
 * still starts cleanly.
 *
 * Must never throw or block startup: there is frequently no collector
 * reachable (local dev, tests, a task whose sidecar hasn't finished
 * starting), and losing telemetry is an acceptable failure mode — refusing
 * to serve traffic because of it is not. `NodeSDK#start()` only registers
 * the exporter and instrumentation; it does not dial the collector, so an
 * unreachable endpoint surfaces later as a background export failure, not a
 * startup error. This still wraps everything in try/catch in case a future
 * SDK version changes that, or a bad `OTEL_EXPORTER_OTLP_ENDPOINT` value
 * throws synchronously while constructing the exporter.
 *
 * Call this before importing anything that should be auto-instrumented
 * (e.g. `@grpc/grpc-js`) — for the gRPC services that means the very top of
 * `main.ts`/`worker-main.ts`, before any other import runs.
 */
export function startTracing(serviceName: string): TracingHandle | null {
  try {
    const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_ENDPOINT).replace(
      /\/+$/,
      "",
    );

    const sdk = new NodeSDK({
      resource: defaultResource().merge(
        resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
      ),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      // Auto-instruments @grpc/grpc-js clients and servers: a call made
      // through an instrumented client/server carries real W3C trace-context
      // over gRPC metadata, giving true parent/child span linkage between
      // e.g. api-gateway and auth-svc without any code change at the call
      // sites.
      instrumentations: [new GrpcInstrumentation()],
    });

    sdk.start();

    let shutDown = false;
    const shutdown = async () => {
      if (shutDown) return;
      shutDown = true;
      try {
        await sdk.shutdown();
      } catch (err) {
        console.error(`otel: error shutting down tracing for ${serviceName}:`, err);
      }
    };

    // Registered in addition to each service's own drain handlers — Node
    // allows multiple listeners per signal, and flushing buffered spans on
    // the way out is harmless to run alongside the app's own shutdown work.
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => void shutdown());
    }

    return { shutdown };
  } catch (err) {
    console.error(`otel: failed to start tracing for ${serviceName}:`, err);
    return null;
  }
}

/**
 * Tags the active span (if any) with VidForge's own trace id, so spans from
 * every hop of one request — gateway, auth-svc, video-svc — can be found by
 * that id regardless of whether real trace-context propagation linked them
 * as parent/child. A no-op when there is no active span (e.g. tracing failed
 * to start) or no trace id (e.g. an unauthenticated RPC).
 */
export function tagTraceId(traceId: string | undefined): void {
  if (!traceId) return;
  trace.getActiveSpan()?.setAttribute(TRACE_ID_ATTRIBUTE, traceId);
}
