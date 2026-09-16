import { Server, ServerCredentials } from "@grpc/grpc-js";
import { VideoServiceService } from "@vidforge/proto/video";
import { createHealthRegistry, drainOnSignals, registerHealthService } from "@vidforge/grpc-health";
import { videoServiceImpl } from "./service.js";
import { startWorker } from "./worker.js";

const PORT = process.env.PORT ?? "50051";
const SERVICE_NAME = "vidforge.video.v1.VideoService";

// In production the worker runs as its own service (worker-main.ts) so the
// API task doesn't need ffmpeg; locally one process does both.
const inlineWorker = process.env.DISABLE_INLINE_WORKER !== "1" ? startWorker() : null;

const server = new Server();
server.addService(VideoServiceService, videoServiceImpl);

// ECS container health checks and grpc_health_probe call
// grpc.health.v1.Health/Check. The registry starts NOT_SERVING and only
// flips once the port is bound, so a task is never routed to early.
const health = createHealthRegistry([SERVICE_NAME]);
registerHealthService(server, health);
// The inline worker only exists in dev, but it still owns an ffmpeg child
// and a Redis connection that have to be drained with the server.
drainOnSignals(server, health, { onDrain: () => inlineWorker?.close() });

server.bindAsync(`0.0.0.0:${PORT}`, ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error("video-svc failed to bind:", err);
    process.exit(1);
  }
  health.serve();
  console.log(`video-svc listening on :${port}`);
});
