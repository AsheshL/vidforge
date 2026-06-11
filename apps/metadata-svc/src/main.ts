import { Server, ServerCredentials } from "@grpc/grpc-js";

const PORT = process.env.PORT ?? "50052";

// MetadataService implementation lands here; addService once written.
const server = new Server();

server.bindAsync(`0.0.0.0:${PORT}`, ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error("metadata-svc failed to bind:", err);
    process.exit(1);
  }
  console.log(`metadata-svc listening on :${port}`);
});
