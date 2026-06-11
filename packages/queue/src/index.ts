import { Queue, Worker, type Processor } from "bullmq";
import IORedis from "ioredis";

export const TRANSCODE_QUEUE = "transcode";
export const WEBHOOK_QUEUE = "webhook-dispatch";

export interface TranscodeJobData {
  jobId: string; // Postgres TranscodeJob.id
  orgId: string;
  assetId: string;
  sourceStorageKey: string;
  profileJson: unknown; // TranscodeProfile as plain JSON
}

export interface WebhookJobData {
  webhookId: string;
  url: string;
  signingSecret: string;
  payload: unknown;
}

export function createRedis(url = process.env.REDIS_URL ?? "redis://localhost:6379") {
  return new IORedis(url, { maxRetriesPerRequest: null });
}

export function createTranscodeQueue(connection = createRedis()) {
  return new Queue<TranscodeJobData>(TRANSCODE_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: false,
    },
  });
}

export function createTranscodeWorker(
  processor: Processor<TranscodeJobData>,
  connection = createRedis(),
  concurrency = Number(process.env.TRANSCODE_CONCURRENCY ?? 2),
) {
  return new Worker<TranscodeJobData>(TRANSCODE_QUEUE, processor, {
    connection,
    concurrency,
  });
}
