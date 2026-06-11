import { Server, ServerCredentials } from "@grpc/grpc-js";
import { VideoServiceService } from "@vidforge/proto/video";
import { videoServiceImpl } from "./service.js";
import { startWorker } from "./worker.js";

const PORT = process.env.PORT ?? "50051";

startWorker();

const server = new Server();
server.addService(VideoServiceService, videoServiceImpl);

server.bindAsync(`0.0.0.0:${PORT}`, ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error("video-svc failed to bind:", err);
    process.exit(1);
  }
  console.log(`video-svc listening on :${port}`);
});
