import { Queue, Worker, type Processor } from "bullmq";
import { Redis as IORedis } from "ioredis";

export const TRANSCODE_QUEUE = "transcode";
export const WEBHOOK_QUEUE = "webhook-dispatch";
// Pub/sub channel carrying job ids whose in-flight transcode should be killed.
export const TRANSCODE_CANCEL_CHANNEL = "transcode:cancel";

export interface TranscodeJobData {
  jobId: string; // Postgres TranscodeJob.id
  orgId: string;
  assetId: string;
  sourceStorageKey: string;
  profileJson: unknown; // TranscodeProfile as plain JSON
}

// Webhook-subscribable job events, named as stored in Webhook.events
// (QueueEventType names from jobs.proto). PROGRESS is deliberately absent:
// it fires many times per job, which the SSE/StreamQueueEvents feeds
// cover; webhooks carry lifecycle transitions only.
export const WEBHOOK_EVENT_TYPES = [
  "QUEUE_EVENT_TYPE_ENQUEUED",
  "QUEUE_EVENT_TYPE_STARTED",
  "QUEUE_EVENT_TYPE_COMPLETED",
  "QUEUE_EVENT_TYPE_FAILED",
  "QUEUE_EVENT_TYPE_RETRYING",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEvent {
  id: string; // stable per (job, type, attempt); receivers dedupe on it
  type: WebhookEventType;
  orgId: string;
  jobId: string;
  assetId: string;
  attempt: number; // 1-based BullMQ attempt the event belongs to
  detail: string; // failure reason for RETRYING/FAILED, otherwise ""
  occurredAt: string; // ISO-8601
}

// Deliberately no URL or signing secret: the delivery worker looks the
// webhook up when it sends, so the secret never sits in Redis and a
// deleted or deactivated webhook stops receiving immediately.
export interface WebhookJobData {
  webhookId: string;
  event: WebhookEvent;
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

export function createWebhookQueue(connection = createRedis()) {
  return new Queue<WebhookJobData>(WEBHOOK_QUEUE, {
    connection,
    defaultJobOptions: {
      // ~10s, 20s, 40s … ≈ 42 minutes of retrying before giving up.
      attempts: 8,
      backoff: { type: "exponential", delay: 10_000 },
      // Completed ids are kept for a day so a duplicate enqueue of the
      // same event (same custom job id) is still deduplicated.
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 7 * 86_400 },
    },
  });
}

export function createWebhookWorker(
  processor: Processor<WebhookJobData>,
  connection = createRedis(),
  concurrency = Number(process.env.WEBHOOK_CONCURRENCY ?? 10),
) {
  return new Worker<WebhookJobData>(WEBHOOK_QUEUE, processor, { connection, concurrency });
}
