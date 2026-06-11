import { status, type ServiceError } from "@grpc/grpc-js";
import { QueueEvents } from "bullmq";
import { prisma, JobState as DbJobState } from "@vidforge/db";
import { createRedis, createTranscodeQueue, TRANSCODE_QUEUE } from "@vidforge/queue";
import {
  JobState,
  type TranscodeJob as ProtoJob,
  type VideoServiceServer,
} from "@vidforge/proto/video";
import type { RequestContext } from "@vidforge/proto/common";
import { verifyContext } from "@vidforge/svc-auth";

const queue = createTranscodeQueue();
const queueEvents = new QueueEvents(TRANSCODE_QUEUE, { connection: createRedis() });

function grpcError(code: status, message: string): ServiceError {
  return Object.assign(new Error(message), { code, details: message }) as ServiceError;
}

function unimplemented(name: string): ServiceError {
  return grpcError(status.UNIMPLEMENTED, `${name} not implemented yet`);
}

// Every RPC requires a gateway-signed context; a context forged by a caller
// with direct network access to this port fails the signature check.
function authenticate(ctx: RequestContext | undefined): RequestContext | ServiceError {
  const result = verifyContext(ctx);
  return result.ok ? result.context : grpcError(status.UNAUTHENTICATED, result.reason);
}

const STATE_MAP: Record<DbJobState, JobState> = {
  QUEUED: JobState.JOB_STATE_QUEUED,
  PROCESSING: JobState.JOB_STATE_PROCESSING,
  COMPLETED: JobState.JOB_STATE_COMPLETED,
  FAILED: JobState.JOB_STATE_FAILED,
  CANCELLED: JobState.JOB_STATE_CANCELLED,
};

// Creator or org admin/owner may mutate a job. Legacy rows without a
// creator are admin-only.
function canModify(ctx: RequestContext, row: { createdByUserId: string | null }): boolean {
  return (
    (row.createdByUserId !== null && row.createdByUserId === ctx.userId) ||
    ctx.roles.some((r) => r === "ADMIN" || r === "OWNER")
  );
}

function toProtoJob(row: {
  id: string;
  assetId: string;
  orgId: string;
  createdByUserId: string | null;
  state: DbJobState;
  progressPercent: number;
  errorMessage: string | null;
  submittedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}): ProtoJob {
  return {
    jobId: row.id,
    assetId: row.assetId,
    orgId: row.orgId,
    createdByUserId: row.createdByUserId ?? "",
    state: STATE_MAP[row.state],
    profile: undefined,
    progressPercent: row.progressPercent,
    errorMessage: row.errorMessage ?? "",
    submittedAt: row.submittedAt,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
  };
}

export const videoServiceImpl: VideoServiceServer = {
  submitTranscodeJob: async (call, callback) => {
    try {
      const req = call.request;
      const ctx = authenticate(req.context);
      if (ctx instanceof Error) return callback(ctx);
      if (!req.assetId || !req.sourceStorageKey || !req.profile?.renditions.length) {
        return callback(
          grpcError(status.INVALID_ARGUMENT, "assetId, sourceStorageKey and profile.renditions are required"),
        );
      }

      // Idempotency: return the existing job if this key was already used.
      if (req.idempotencyKey) {
        const existing = await prisma.transcodeJob.findUnique({
          where: { idempotencyKey: req.idempotencyKey },
        });
        if (existing) {
          return callback(null, { jobId: existing.id, state: STATE_MAP[existing.state] });
        }
      }

      const profileJson = {
        renditions: req.profile.renditions.map((r) => ({
          name: r.name,
          width: r.width,
          height: r.height,
          videoBitrateKbps: r.videoBitrateKbps,
          audioBitrateKbps: r.audioBitrateKbps,
        })),
        hlsSegmentSeconds: req.profile.hlsSegmentSeconds || 6,
        generateThumbnails: req.profile.generateThumbnails,
        thumbnailIntervalSeconds: req.profile.thumbnailIntervalSeconds || 10,
      };

      const row = await prisma.transcodeJob.create({
        data: {
          assetId: req.assetId,
          orgId: ctx.orgId,
          createdByUserId: ctx.userId,
          profileJson,
          priority: req.priority,
          idempotencyKey: req.idempotencyKey || null,
        },
      });

      // BullMQ job id mirrors the Postgres row id so progress events correlate.
      await queue.add(
        "transcode",
        {
          jobId: row.id,
          orgId: ctx.orgId,
          assetId: req.assetId,
          sourceStorageKey: req.sourceStorageKey,
          profileJson,
        },
        { jobId: row.id, priority: req.priority || undefined },
      );

      await prisma.asset.update({
        where: { id: req.assetId },
        data: { status: "PROCESSING" },
      });

      callback(null, { jobId: row.id, state: JobState.JOB_STATE_QUEUED });
    } catch (err) {
      callback(grpcError(status.INTERNAL, (err as Error).message));
    }
  },

  getJob: async (call, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    const row = await prisma.transcodeJob.findUnique({ where: { id: call.request.jobId } });
    if (!row || row.orgId !== ctx.orgId) {
      return callback(grpcError(status.NOT_FOUND, "job not found"));
    }
    callback(null, toProtoJob(row));
  },

  streamProgress: async (call) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) {
      call.emit("error", ctx);
      return;
    }
    const { jobId } = call.request;
    const row = await prisma.transcodeJob.findUnique({ where: { id: jobId } });
    if (!row || row.orgId !== ctx.orgId) {
      call.emit("error", grpcError(status.NOT_FOUND, "job not found"));
      return;
    }

    const send = (state: JobState, percent: number, rendition = "", fps = 0) =>
      call.write({
        jobId,
        state,
        percent,
        currentRendition: rendition,
        fps,
        eta: undefined,
        emittedAt: new Date(),
      });

    if (row.state !== "QUEUED" && row.state !== "PROCESSING") {
      send(STATE_MAP[row.state], row.progressPercent);
      return call.end();
    }

    const onProgress = ({ jobId: id, data }: { jobId: string; data: unknown }) => {
      if (id !== jobId) return;
      const p = data as { percent: number; rendition: string; fps: number };
      send(JobState.JOB_STATE_PROCESSING, p.percent, p.rendition, p.fps);
    };
    const onCompleted = ({ jobId: id }: { jobId: string }) => {
      if (id !== jobId) return;
      send(JobState.JOB_STATE_COMPLETED, 100);
      cleanup();
      call.end();
    };
    const onFailed = ({ jobId: id }: { jobId: string }) => {
      if (id !== jobId) return;
      send(JobState.JOB_STATE_FAILED, row.progressPercent);
      cleanup();
      call.end();
    };
    const cleanup = () => {
      queueEvents.off("progress", onProgress);
      queueEvents.off("completed", onCompleted);
      queueEvents.off("failed", onFailed);
    };

    queueEvents.on("progress", onProgress);
    queueEvents.on("completed", onCompleted);
    queueEvents.on("failed", onFailed);
    call.on("cancelled", cleanup);

    send(STATE_MAP[row.state], row.progressPercent);
  },

  cancelJob: async (call, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    const row = await prisma.transcodeJob.findUnique({ where: { id: call.request.jobId } });
    if (!row || row.orgId !== ctx.orgId) {
      return callback(grpcError(status.NOT_FOUND, "job not found"));
    }
    if (!canModify(ctx, row)) {
      return callback(grpcError(status.PERMISSION_DENIED, "only the job's creator or an admin can cancel it"));
    }
    if (row.state !== "QUEUED" && row.state !== "PROCESSING") {
      return callback(grpcError(status.FAILED_PRECONDITION, `job is already ${row.state.toLowerCase()}`));
    }
    // Removing the BullMQ entry stops queued jobs outright; a job already
    // processing finishes its current run but the row stays CANCELLED.
    await queue.remove(row.id).catch(() => {});
    const updated = await prisma.transcodeJob.update({
      where: { id: row.id },
      data: { state: "CANCELLED", finishedAt: new Date() },
    });
    callback(null, toProtoJob(updated));
  },

  deleteJob: async (call, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    const row = await prisma.transcodeJob.findUnique({ where: { id: call.request.jobId } });
    if (!row || row.orgId !== ctx.orgId) {
      return callback(grpcError(status.NOT_FOUND, "job not found"));
    }
    if (!canModify(ctx, row)) {
      return callback(grpcError(status.PERMISSION_DENIED, "only the job's creator or an admin can delete it"));
    }
    if (row.state === "QUEUED" || row.state === "PROCESSING") {
      return callback(grpcError(status.FAILED_PRECONDITION, "cancel the job before deleting it"));
    }
    await prisma.transcodeJob.delete({ where: { id: row.id } });
    callback(null, { deleted: true });
  },

  listJobs: async (call, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    const rows = await prisma.transcodeJob.findMany({
      where: {
        orgId: ctx.orgId,
        ...(call.request.assetId ? { assetId: call.request.assetId } : {}),
      },
      orderBy: { submittedAt: "desc" },
      take: Math.min(call.request.page?.pageSize || 20, 100),
    });
    callback(null, {
      jobs: rows.map(toProtoJob),
      pageInfo: { nextPageToken: "", totalCount: rows.length },
    });
  },

  getOutputManifest: async (call, callback) => {
    const ctx = authenticate(call.request.context);
    if (ctx instanceof Error) return callback(ctx);
    const row = await prisma.transcodeJob.findUnique({ where: { id: call.request.jobId } });
    if (!row || row.orgId !== ctx.orgId) {
      return callback(grpcError(status.NOT_FOUND, "job not found"));
    }
    if (row.state !== "COMPLETED" || !row.manifestJson) {
      return callback(grpcError(status.FAILED_PRECONDITION, "job has no manifest yet"));
    }
    const m = row.manifestJson as {
      playlistStorageKey: string;
      thumbnailStorageKeys: string[];
    };
    callback(null, {
      jobId: row.id,
      assetId: row.assetId,
      packaging: 1, // HLS
      playlistStorageKey: m.playlistStorageKey,
      renditions: [],
      thumbnailStorageKeys: m.thumbnailStorageKeys,
      sourceDuration: undefined,
    });
  },

  generateThumbnails: (_call, callback) => callback(unimplemented("GenerateThumbnails")),
};
