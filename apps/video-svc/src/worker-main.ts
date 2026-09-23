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
