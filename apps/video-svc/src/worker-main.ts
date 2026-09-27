// Tracing (OpenTelemetry SDK) is started before this file is even loaded,
// via `--import ../../packages/otel/src/register.ts` on the process's
// command line (see this package's Dockerfile `worker` target CMD) — see
// packages/otel/src/register.ts for why that has to happen there and not
// here. The worker doesn't handle a gRPC-carried RequestContext today, so
// there's nothing here (yet) to tag with trace_id, but the SDK still runs
// so future spans (BullMQ job processing, ffmpeg calls) have somewhere to
// export to.
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { createTranscodeQueue } from "@vidforge/queue";
import { startWorker } from "./worker.js";

const worker = startWorker();

// Autoscaling signal for the worker service (infra/terraform/ecs-autoscaling.tf):
// ECS/CloudWatch have no native concept of "BullMQ queue depth", so the
// worker publishes it itself. Namespace/metric/dimension names here must
// match the CloudWatch alarms exactly, or the autoscaling policy never
// fires.
const QUEUE_METRIC_NAMESPACE = "VidForge/Queue";
const QUEUE_METRIC_INTERVAL_MS = 30_000;

const cloudwatch = new CloudWatchClient({});
const queue = createTranscodeQueue();

const metricInterval = setInterval(() => {
  void queue
    .getWaitingCount()
    .then((count) =>
      cloudwatch.send(
        new PutMetricDataCommand({
          Namespace: QUEUE_METRIC_NAMESPACE,
          MetricData: [
            {
              MetricName: "WaitingJobs",
              Value: count,
              Unit: "Count",
              Dimensions: [{ Name: "QueueName", Value: "transcode" }],
            },
          ],
        }),
      ),
    )
    .catch((err) => console.error("failed to publish queue depth metric:", err));
}, QUEUE_METRIC_INTERVAL_MS);

// ECS sends SIGTERM on deploy/scale-in; close() waits for the in-flight
// job to finish (or be requeued) before exiting.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, draining worker`);
    clearInterval(metricInterval);
    void worker.close().then(() => process.exit(0));
  });
}
