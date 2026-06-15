import { Server, ServerCredentials } from "@grpc/grpc-js";
import { VideoServiceService } from "@vidforge/proto/video";
import { videoServiceImpl } from "./service.js";
import { startWorker } from "./worker.js";

const PORT = process.env.PORT ?? "50051";

// In production the worker runs as its own service (worker-main.ts) so the
// API task doesn't need ffmpeg; locally one process does both.
if (process.env.DISABLE_INLINE_WORKER !== "1") {
  startWorker();
}

const server = new Server();
server.addService(VideoServiceService, videoServiceImpl);

server.bindAsync(`0.0.0.0:${PORT}`, ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error("video-svc failed to bind:", err);
    process.exit(1);
  }
  console.log(`video-svc listening on :${port}`);
});
