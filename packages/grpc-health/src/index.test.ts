import { Server, ServerCredentials } from "@grpc/grpc-js";
import { afterEach, describe, expect, it } from "vitest";
import { createHealthRegistry, probeHealth, registerHealthService, type HealthRegistry } from "./index.js";

const SERVICE = "vidforge.test.v1.Thing";

const running: Server[] = [];

afterEach(() => {
  for (const server of running.splice(0)) server.forceShutdown();
});

async function startServer(): Promise<{ address: string; registry: HealthRegistry }> {
  const server = new Server();
  const registry = createHealthRegistry([SERVICE]);
  registerHealthService(server, registry);
  running.push(server);

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (err, boundPort) =>
      err ? reject(err) : resolve(boundPort),
    );
  });
  return { address: `127.0.0.1:${port}`, registry };
}

describe("health registry", () => {
  it("reports NOT_SERVING until the server marks itself ready", async () => {
    const { address, registry } = await startServer();

    expect(await probeHealth(address)).toBe(false);
    registry.serve();
    expect(await probeHealth(address)).toBe(true);
  });

  it("tracks per-service status independently of the server overall", async () => {
    const { address, registry } = await startServer();
    registry.serve();

    registry.setStatus(SERVICE, "NOT_SERVING");
    expect(await probeHealth(address, SERVICE)).toBe(false);
    expect(await probeHealth(address)).toBe(true);
  });

  it("fails the probe for a service the server does not know about", async () => {
    const { address, registry } = await startServer();
    registry.serve();

    expect(await probeHealth(address, "vidforge.test.v1.Missing")).toBe(false);
  });

  it("drain takes everything out of rotation", async () => {
    const { address, registry } = await startServer();
    registry.serve();
    registry.drain();

    expect(await probeHealth(address)).toBe(false);
    expect(await probeHealth(address, SERVICE)).toBe(false);
    expect(registry.getStatus(SERVICE)).toBe("NOT_SERVING");
  });

  it("fails the probe when nothing is listening", async () => {
    // Port 1 is never bound in the test sandbox; the probe must resolve
    // false rather than hang or throw.
    expect(await probeHealth("127.0.0.1:1", "", 500)).toBe(false);
  });
});
