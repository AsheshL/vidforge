import type { Queue } from "bullmq";
import { prisma } from "@vidforge/db";
import type { WebhookEvent, WebhookEventType, WebhookJobData } from "@vidforge/queue";

export interface JobEventInput {
  type: WebhookEventType;
  orgId: string;
  jobId: string;
  assetId: string;
  attempt: number;
  detail?: string;
}

type WebhookLookup = (orgId: string, type: WebhookEventType) => Promise<{ id: string }[]>;

const activeWebhooksFor: WebhookLookup = (orgId, type) =>
  prisma.webhook.findMany({ where: { orgId, active: true, events: { has: type } }, select: { id: true } });

// Returns a fire-and-forget publisher: called at each job state transition,
// it enqueues one delivery per subscribed webhook. It never throws — a
// webhook bookkeeping failure must not fail or retry the transcode itself.
export function createWebhookPublisher(queue: Queue<WebhookJobData>, findWebhooks: WebhookLookup = activeWebhooksFor) {
  return async function publish(input: JobEventInput): Promise<void> {
    try {
      const hooks = await findWebhooks(input.orgId, input.type);
      if (hooks.length === 0) return;

      const shortType = input.type.replace("QUEUE_EVENT_TYPE_", "").toLowerCase();
      const event: WebhookEvent = {
        id: `evt_${input.jobId}_${shortType}_${input.attempt}`,
        type: input.type,
        orgId: input.orgId,
        jobId: input.jobId,
        assetId: input.assetId,
        attempt: input.attempt,
        detail: input.detail ?? "",
        occurredAt: new Date().toISOString(),
      };
      // Custom job id = (webhook, event): BullMQ ignores an add whose id
      // already exists, so a transition published twice (a retried DB
      // write, a redelivered BullMQ event) still produces one delivery.
      // BullMQ forbids ':' in custom ids, hence '-'.
      await queue.addBulk(
        hooks.map((h) => ({
          name: event.type,
          data: { webhookId: h.id, event },
          opts: { jobId: `${h.id}-${event.id}` },
        })),
      );
    } catch (err) {
      console.error(`failed to enqueue ${input.type} webhooks for job ${input.jobId}:`, (err as Error).message);
    }
  };
}

export type WebhookPublisher = ReturnType<typeof createWebhookPublisher>;
