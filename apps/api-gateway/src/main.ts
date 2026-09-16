import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { credentials } from "@grpc/grpc-js";
import { VideoServiceClient } from "@vidforge/proto/video";
import { authClient } from "./auth.js";
import { createRateLimitRedis, parseTrustProxy } from "./config.js";
import { registerTranscodeRoutes } from "./routes/transcode.js";
import { registerPlaybackRoutes } from "./routes/playback.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerOrgRoutes } from "./routes/org.js";
import { registerDevRoutes } from "./routes/dev.js";

// Behind a load balancer every request arrives from the proxy, so without
// trustProxy req.ip is the balancer for all of them and the per-IP limits
// below would be one shared budget for the whole internet.
const app = Fastify({ logger: true, trustProxy: parseTrustProxy(process.env.TRUST_PROXY) });

await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  // PATCH and the exposed headers are required by the tus upload protocol.
  methods: ["GET", "HEAD", "POST", "DELETE", "PATCH"],
  exposedHeaders: ["Location", "Upload-Offset", "Upload-Length", "Tus-Resumable"],
});

// global:false — only routes that opt in via config.rateLimit are limited
// (the auth endpoints). Keyed by client IP; counters live in Redis so the
// limit holds across gateway replicas.
const rateLimitRedis = createRateLimitRedis(app.log);
await app.register(rateLimit, {
  global: false,
  nameSpace: "vidforge:rl:",
  // Defaults to false, which turns a Redis outage into 500s on login and
  // signup. Losing the limiter is bad; losing authentication is worse.
  skipOnError: true,
  ...(rateLimitRedis ? { redis: rateLimitRedis } : {}),
});

const videoClient = new VideoServiceClient(
  process.env.VIDEO_SVC_ADDR ?? "localhost:50051",
  credentials.createInsecure(),
);

let draining = false;

// The load balancer polls this. Reporting 503 as soon as the drain starts
// takes the task out of rotation while it is still finishing what it has.
app.get("/healthz", async (_req, reply) => {
  if (draining) return reply.code(503).send({ ok: false, status: "draining" });
  return { ok: true };
});

registerTranscodeRoutes(app, videoClient);
registerPlaybackRoutes(app, videoClient);
registerAccountRoutes(app);
registerUploadRoutes(app);
registerAssetRoutes(app);
registerOrgRoutes(app);
registerDevRoutes(app, videoClient);

// Keep under the platform's stop timeout (ECS `stopTimeout`, compose
// `stop_grace_period`) so the process exits before it is SIGKILLed.
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000);

async function shutdown(signal: NodeJS.Signals) {
  if (draining) return;
  draining = true;
  app.log.info(`${signal} received, draining`);

  const force = setTimeout(() => {
    app.log.error(`drain exceeded ${SHUTDOWN_GRACE_MS}ms, forcing exit`);
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  force.unref();

  try {
    // close() runs the onClose hooks — which end the open SSE streams, the
    // only connections that would otherwise never finish on their own — then
    // waits for in-flight requests (tus PATCHes included) before the port drops.
    await app.close();
    videoClient.close();
    authClient.close();
    // QUIT throws if the connection is already gone — that is not a reason
    // to exit non-zero, so fall back to dropping the socket.
    await rateLimitRedis?.quit().catch(() => rateLimitRedis?.disconnect());
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "error while draining");
    process.exit(1);
  }
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

export { videoClient };
