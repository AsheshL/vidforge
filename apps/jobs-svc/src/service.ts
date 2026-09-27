import { status, type ServiceError } from "@grpc/grpc-js";
import { QueueEvents } from "bullmq";
import { randomBytes } from "node:crypto";
import { prisma } from "@vidforge/db";
import { createRedis, createTranscodeQueue, TRANSCODE_QUEUE } from "@vidforge/queue";
import {
  QueueEventType,
  queueEventTypeFromJSON,
  type GetQueueStatsRequest,
  type JobQueueServiceServer,
  type QueueStats,
  type Webhook as ProtoWebhook,
} from "@vidforge/proto/jobs";
import type { RequestContext } from "@vidforge/proto/common";
import { verifyContext } from "@vidforge/svc-auth";

const queue = createTranscodeQueue();
const queueEvents = new QueueEvents(TRANSCODE_QUEUE, { connection: createRedis() });

const DAY_MS = 24 * 60 * 60 * 1000;

function grpcError(code: status, message: string): ServiceError {
  return Object.assign(new Error(message), { code, details: message }) as ServiceError;
}

// Every RPC on this service requires a gateway-signed context — there is no
// public entry point like AuthService's VerifyToken/IssueDevToken.
function authenticate(ctx: RequestContext | undefined): RequestContext | ServiceError {
  const result = verifyContext(ctx);
  return result.ok ? result.context : grpcError(status.UNAUTHENTICATED, result.reason);
}

function avg(values: number[]): number {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

type WebhookRow = {
  id: string;
  orgId: string;
  url: string;
  events: string[];
  signingSecret: string;
  active: boolean;
};

function toProtoWebhook(row: WebhookRow): ProtoWebhook {
  return {
    webhookId: row.id,
    orgId: row.orgId,
    url: row.url,
    events: row.events.map((e) => queueEventTypeFromJSON(e)),
    // Full secret is only ever returned once, at registration time.
    signingSecretHint: row.signingSecret.slice(-4),
    active: row.active,
  };
}

async function computeQueueStats(orgId: string): Promise<QueueStats> {
  // BullMQ has no notion of an org, but every TranscodeJobData payload
  // carries the orgId it was submitted for (see video-svc's
  // submitTranscodeJob), so live in-flight counts are scoped by filtering
  // on that field directly rather than round-tripping through Postgres for
  // every job currently sitting in Redis.
  const [waiting, active] = await Promise.all([
    queue.getJobs(["waiting", "delayed"], 0, -1),
    queue.getJobs(["active"], 0, -1),
  ]);
  const queued = waiting.filter((j) => j.data?.orgId === orgId).length;
  const activeCount = active.filter((j) => j.data?.orgId === orgId).length;

  // Completed/failed counts and durations come from Postgres instead:
  // createTranscodeQueue prunes completed jobs after 24h and BullMQ was
  // never meant as a durable historical store, whereas TranscodeJob rows
  // stick around and are already indexed by (orgId, state).
  const since = new Date(Date.now() - DAY_MS);
  const [completed24h, failed24h, recentRows] = await Promise.all([
    prisma.transcodeJob.count({
      where: { orgId, state: "COMPLETED", finishedAt: { gte: since } },
    }),
    prisma.transcodeJob.count({
      where: { orgId, state: "FAILED", finishedAt: { gte: since } },
    }),
    prisma.transcodeJob.findMany({
      where: { orgId, state: { in: ["COMPLETED", "FAILED"] }, finishedAt: { gte: since } },
      select: { submittedAt: true, startedAt: true, finishedAt: true },
    }),
  ]);

  const waits = recentRows
    .filter((r) => r.startedAt)
    .map((r) => (r.startedAt!.getTime() - r.submittedAt.getTime()) / 1000);
  const durations = recentRows
    .filter((r) => r.startedAt && r.finishedAt)
    .map((r) => (r.finishedAt!.getTime() - r.startedAt!.getTime()) / 1000);

  return {
    queued,
    active: activeCount,
    completed24h,
    failed24h,
    avgWaitSeconds: avg(waits),
    avgProcessingSeconds: avg(durations),
  };
}

export const jobQueueServiceImpl: JobQueueServiceServer = {
  getQueueStats: async (call: { request: GetQueueStatsRequest }, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    try {
      callback(null, await computeQueueStats(ctx.orgId));
    } catch (err) {
      callback(grpcError(status.INTERNAL, (err as Error).message));
    }
  },

  streamQueueEvents: (call) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) {
      call.emit("error", ctx);
      return;
    }

    const emit = (type: QueueEventType, jobId: string, assetId: string, percent: number, detail: string) =>
      call.write({ type, jobId, assetId, percent, detail, occurredAt: new Date() });

    // BullMQ's global event bus only carries a jobId; the org and asset for
    // that job are looked up from the TranscodeJob row whose id mirrors the
    // BullMQ job id (see video-svc's submitTranscodeJob).
    const forOrg = async (jobId: string) => {
      const row = await prisma.transcodeJob.findUnique({ where: { id: jobId } });
      return row && row.orgId === ctx.orgId ? row : null;
    };

    const onWaiting = async ({ jobId }: { jobId: string }) => {
      const row = await forOrg(jobId);
      if (row) emit(QueueEventType.QUEUE_EVENT_TYPE_ENQUEUED, jobId, row.assetId, 0, "");
    };
    const onActive = async ({ jobId }: { jobId: string }) => {
      const row = await forOrg(jobId);
      if (row) emit(QueueEventType.QUEUE_EVENT_TYPE_STARTED, jobId, row.assetId, 0, "");
    };
    const onProgress = async ({ jobId, data }: { jobId: string; data: unknown }) => {
      const row = await forOrg(jobId);
      if (!row) return;
      const percent =
        typeof data === "number" ? data : ((data as { percent?: number } | null)?.percent ?? 0);
      emit(QueueEventType.QUEUE_EVENT_TYPE_PROGRESS, jobId, row.assetId, percent, "");
    };
    const onCompleted = async ({ jobId }: { jobId: string }) => {
      const row = await forOrg(jobId);
      if (row) emit(QueueEventType.QUEUE_EVENT_TYPE_COMPLETED, jobId, row.assetId, 100, "");
    };
    // BullMQ fires "failed" on every failed attempt, including ones that
    // still have retries left (with exponential backoff the job goes back
    // to delayed, then waiting). "retries-exhausted" fires once, only when
    // there are no attempts left — that's the terminal FAILED; every other
    // "failed" is a RETRYING. (For a job configured with a single attempt,
    // both events fire back-to-back on that one failure — RETRYING
    // immediately followed by FAILED — which is a harmless redundancy.)
    const onFailed = async ({ jobId, failedReason }: { jobId: string; failedReason: string }) => {
      const row = await forOrg(jobId);
      if (row) emit(QueueEventType.QUEUE_EVENT_TYPE_RETRYING, jobId, row.assetId, row.progressPercent, failedReason);
    };
    const onRetriesExhausted = async ({ jobId }: { jobId: string }) => {
      const row = await forOrg(jobId);
      if (row) {
        emit(QueueEventType.QUEUE_EVENT_TYPE_FAILED, jobId, row.assetId, row.progressPercent, row.errorMessage ?? "");
      }
    };

    queueEvents.on("waiting", onWaiting);
    queueEvents.on("active", onActive);
    queueEvents.on("progress", onProgress);
    queueEvents.on("completed", onCompleted);
    queueEvents.on("failed", onFailed);
    queueEvents.on("retries-exhausted", onRetriesExhausted);

    const cleanup = () => {
      queueEvents.off("waiting", onWaiting);
      queueEvents.off("active", onActive);
      queueEvents.off("progress", onProgress);
      queueEvents.off("completed", onCompleted);
      queueEvents.off("failed", onFailed);
      queueEvents.off("retries-exhausted", onRetriesExhausted);
    };
    call.on("cancelled", cleanup);
    call.on("close", cleanup);
    call.on("error", cleanup);
  },

  registerWebhook: async (call, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    const { url, events } = call.request;
    if (!/^https?:\/\//.test(url)) {
      return callback(grpcError(status.INVALID_ARGUMENT, "url must be an http(s) URL"));
    }
    const validEvents = events.filter(
      (e) => e !== QueueEventType.QUEUE_EVENT_TYPE_UNSPECIFIED && e !== QueueEventType.UNRECOGNIZED,
    );
    if (!validEvents.length) {
      return callback(grpcError(status.INVALID_ARGUMENT, "at least one event type is required"));
    }
    // Shown in full to the caller exactly once; only the hint (last 4
    // chars, via toProtoWebhook) is ever readable again after this.
    const signingSecret = `whsec_${randomBytes(24).toString("hex")}`;
    const row = await prisma.webhook.create({
      data: {
        orgId: ctx.orgId,
        url,
        events: validEvents.map((e) => QueueEventType[e]),
        signingSecret,
        active: true,
      },
    });
    callback(null, toProtoWebhook(row));
  },

  listWebhooks: async (call, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    const rows = await prisma.webhook.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { createdAt: "desc" },
    });
    callback(null, { webhooks: rows.map(toProtoWebhook) });
  },

  deleteWebhook: async (call, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    const row = await prisma.webhook.findUnique({ where: { id: call.request.webhookId } });
    if (!row || row.orgId !== ctx.orgId) {
      return callback(grpcError(status.NOT_FOUND, "webhook not found"));
    }
    await prisma.webhook.delete({ where: { id: row.id } });
    callback(null, { deleted: true });
  },

  getUsage: async (call, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    const from = call.request.from ?? new Date(0);
    const to = call.request.to ?? new Date();
    const rows = await prisma.transcodeJob.findMany({
      where: { orgId: ctx.orgId, state: "COMPLETED", finishedAt: { gte: from, lte: to } },
      select: { startedAt: true, finishedAt: true },
    });
    const transcodeMinutes = rows.reduce((sum, r) => {
      if (!r.startedAt || !r.finishedAt) return sum;
      return sum + (r.finishedAt.getTime() - r.startedAt.getTime()) / 60_000;
    }, 0);
    callback(null, {
      orgId: ctx.orgId,
      transcodeMinutes,
      // Neither is tracked anywhere today: Asset.sourceBytes is the
      // *source* upload's size, not a transcode's output size, and nothing
      // in the schema records egress/delivery byte counts at all. Reporting
      // 0 here rather than inventing new tracking as part of this RPC.
      storageBytes: 0,
      egressBytes: 0,
      jobsCompleted: rows.length,
    });
  },
};
