import { Server, ServerCredentials } from "@grpc/grpc-js";
import { AuthServiceService } from "@vidforge/proto/auth";
import { createHealthRegistry, drainOnSignals, registerHealthService } from "@vidforge/grpc-health";
import { authServiceImpl } from "./service.js";

const PORT = process.env.PORT ?? "50053";
const SERVICE_NAME = "vidforge.auth.v1.AuthService";

const server = new Server();
server.addService(AuthServiceService, authServiceImpl);

// ECS container health checks and grpc_health_probe call
// grpc.health.v1.Health/Check. The registry starts NOT_SERVING and only
// flips once the port is bound, so a task is never routed to early.
const health = createHealthRegistry([SERVICE_NAME]);
registerHealthService(server, health);
drainOnSignals(server, health);

server.bindAsync(`0.0.0.0:${PORT}`, ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error("auth-svc failed to bind:", err);
    process.exit(1);
  }
  health.serve();
  console.log(`auth-svc listening on :${port}`);
});
