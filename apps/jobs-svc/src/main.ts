import { Server, ServerCredentials } from "@grpc/grpc-js";
import { JobQueueServiceService } from "@vidforge/proto/jobs";
import { createHealthRegistry, drainOnSignals, registerHealthService } from "@vidforge/grpc-health";
import { createWebhookWorker } from "@vidforge/queue";
import { createWebhookProcessor, targetPolicyFromEnv } from "@vidforge/webhooks";
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

// Webhook delivery runs in this process: jobs-svc owns webhooks end to end
// (registration via the RPCs above, delivery here). Events are enqueued by
// video-svc at each job state transition (see @vidforge/webhooks publish).
const webhookWorker = createWebhookWorker(createWebhookProcessor({ policy: targetPolicyFromEnv() }));
webhookWorker.on("failed", (job, err) => {
  if (!job) return;
  const final = job.attemptsMade >= (job.opts.attempts ?? 1) || err.name === "UnrecoverableError";
  console.error(
    `webhook delivery ${job.id} ${final ? "gave up" : `failed (attempt ${job.attemptsMade})`}: ${err.message}`,
  );
});

drainOnSignals(server, health, { onDrain: () => webhookWorker.close() });

server.bindAsync(`0.0.0.0:${PORT}`, ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error("jobs-svc failed to bind:", err);
    process.exit(1);
  }
  health.serve();
  console.log(`jobs-svc listening on :${port}`);
});
