import http from "node:http";
import https from "node:https";
import { UnrecoverableError, type Processor } from "bullmq";
import { prisma } from "@vidforge/db";
import type { WebhookEvent, WebhookEventType, WebhookJobData } from "@vidforge/queue";
import { SIGNATURE_HEADER, signWebhookPayload } from "./signature.js";
import { guardedLookup, validateWebhookUrl, WebhookTargetError, type TargetPolicy } from "./target.js";

export const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

// Public names in the delivered payload; Webhook.events keeps the proto
// enum names so it round-trips through RegisterWebhook/ListWebhooks.
const PUBLIC_EVENT_NAMES: Record<WebhookEventType, string> = {
  QUEUE_EVENT_TYPE_ENQUEUED: "job.enqueued",
  QUEUE_EVENT_TYPE_STARTED: "job.started",
  QUEUE_EVENT_TYPE_COMPLETED: "job.completed",
  QUEUE_EVENT_TYPE_FAILED: "job.failed",
  QUEUE_EVENT_TYPE_RETRYING: "job.retrying",
};

export function webhookPayload(event: WebhookEvent) {
  return {
    id: event.id,
    type: PUBLIC_EVENT_NAMES[event.type],
    createdAt: event.occurredAt,
    data: {
      orgId: event.orgId,
      jobId: event.jobId,
      assetId: event.assetId,
      attempt: event.attempt,
      detail: event.detail,
    },
  };
}

// Retry on anything that might succeed later; give up on responses that
// say the request itself is unacceptable. Redirects aren't followed and
// count as permanent — a moved endpoint needs re-registering.
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function post(
  url: URL,
  body: string,
  headers: Record<string, string>,
  policy: TargetPolicy,
  timeoutMs: number,
): Promise<number> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body).toString() },
        lookup: guardedLookup(policy),
        timeout: timeoutMs,
      },
      (res) => {
        res.resume(); // the response body is irrelevant; drain it
        res.on("end", () => resolve(res.statusCode ?? 0));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(body);
  });
}

type WebhookRow = { id: string; url: string; signingSecret: string; active: boolean };
type WebhookFinder = (id: string) => Promise<WebhookRow | null>;

const findWebhook: WebhookFinder = (id) => prisma.webhook.findUnique({ where: { id } });

export function createWebhookProcessor({
  policy,
  timeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS,
  find = findWebhook,
}: {
  policy: TargetPolicy;
  timeoutMs?: number;
  find?: WebhookFinder;
}): Processor<WebhookJobData> {
  return async (job) => {
    const { webhookId, event } = job.data;
    const hook = await find(webhookId);
    // Deleted or deactivated since the event was queued: drop quietly.
    if (!hook || !hook.active) return { skipped: true };

    let url: URL;
    try {
      url = validateWebhookUrl(hook.url, policy);
    } catch (err) {
      throw new UnrecoverableError((err as Error).message);
    }

    const body = JSON.stringify(webhookPayload(event));
    let status: number;
    try {
      status = await post(
        url,
        body,
        {
          "content-type": "application/json",
          "user-agent": "VidForge-Webhooks/1",
          "vidforge-event-id": event.id,
          "vidforge-event-type": PUBLIC_EVENT_NAMES[event.type],
          [SIGNATURE_HEADER]: signWebhookPayload(hook.signingSecret, body),
        },
        policy,
        timeoutMs,
      );
    } catch (err) {
      // Resolving to an internal address won't change on retry.
      if (err instanceof WebhookTargetError) throw new UnrecoverableError(err.message);
      throw err; // network error / timeout: retry with backoff
    }

    if (status >= 200 && status < 300) return { status };
    const message = `webhook ${webhookId} responded ${status}`;
    throw isRetryableStatus(status) ? new Error(message) : new UnrecoverableError(message);
  };
}
