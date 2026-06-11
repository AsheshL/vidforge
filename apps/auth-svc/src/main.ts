import { Server, ServerCredentials } from "@grpc/grpc-js";
import { AuthServiceService } from "@vidforge/proto/auth";
import { authServiceImpl } from "./service.js";

const PORT = process.env.PORT ?? "50053";

const server = new Server();
server.addService(AuthServiceService, authServiceImpl);

server.bindAsync(`0.0.0.0:${PORT}`, ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error("auth-svc failed to bind:", err);
    process.exit(1);
  }
  console.log(`auth-svc listening on :${port}`);
});
