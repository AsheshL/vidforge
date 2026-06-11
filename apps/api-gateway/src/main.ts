import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { credentials } from "@grpc/grpc-js";
import { VideoServiceClient } from "@vidforge/proto/video";
import { registerTranscodeRoutes } from "./routes/transcode.js";
import { registerPlaybackRoutes } from "./routes/playback.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { registerAssetRoutes } from "./routes/assets.js";
import { registerOrgRoutes } from "./routes/org.js";
import { registerDevRoutes } from "./routes/dev.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  // PATCH and the exposed headers are required by the tus upload protocol.
  methods: ["GET", "HEAD", "POST", "DELETE", "PATCH"],
  exposedHeaders: ["Location", "Upload-Offset", "Upload-Length", "Tus-Resumable"],
});

// global:false — only routes that opt in via config.rateLimit are limited
// (the auth endpoints). Keyed by client IP; behind a load balancer set
// trustProxy so req.ip reflects X-Forwarded-For.
await app.register(rateLimit, { global: false });

const videoClient = new VideoServiceClient(
  process.env.VIDEO_SVC_ADDR ?? "localhost:50051",
  credentials.createInsecure(),
);

app.get("/healthz", async () => ({ ok: true }));

registerTranscodeRoutes(app, videoClient);
registerPlaybackRoutes(app, videoClient);
registerAccountRoutes(app);
registerUploadRoutes(app);
registerAssetRoutes(app);
registerOrgRoutes(app);
registerDevRoutes(app, videoClient);

const port = Number(process.env.PORT ?? 4000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

export { videoClient };
