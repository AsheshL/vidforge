import { Server, ServerCredentials } from "@grpc/grpc-js";
import { JobQueueServiceService } from "@vidforge/proto/jobs";
import { createHealthRegistry, drainOnSignals, registerHealthService } from "@vidforge/grpc-health";
import { jobQueueServiceImpl } from "./service.js";

const PORT = process.env.PORT ?? "50054";
const SERVICE_NAME = "vidforge.jobs.v1.JobQueueService";

const server = new Server();
server.addService(JobQueueServiceService, jobQueueServiceImpl);

// ECS container health checks and grpc_health_probe call
// grpc.health.v1.Health/Check. The registry starts NOT_SERVING and only
// flips once the port is bound, so a task is never routed to early.
const health = createHealthRegistry([SERVICE_NAME]);
registerHealthService(server, health);
drainOnSignals(server, health);

server.bindAsync(`0.0.0.0:${PORT}`, ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error("jobs-svc failed to bind:", err);
    process.exit(1);
  }
  health.serve();
  console.log(`jobs-svc listening on :${port}`);
});
