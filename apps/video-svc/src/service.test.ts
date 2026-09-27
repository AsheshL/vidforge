import { status } from "@grpc/grpc-js";
import { JobState } from "@vidforge/proto/video";
import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  queueAdd: vi.fn(),
  publishWebhook: vi.fn(),
}));

vi.mock("@vidforge/webhooks", () => ({
  createWebhookPublisher: vi.fn(() => hoisted.publishWebhook),
}));

vi.mock("bullmq", () => ({
  QueueEvents: vi.fn().mockImplementation(() => ({ on: vi.fn(), off: vi.fn() })),
}));

vi.mock("@vidforge/queue", () => ({
  TRANSCODE_QUEUE: "transcode",
  TRANSCODE_CANCEL_CHANNEL: "transcode:cancel",
  createRedis: vi.fn(() => ({ publish: vi.fn(), subscribe: vi.fn(), on: vi.fn() })),
  createTranscodeQueue: vi.fn(() => ({ add: hoisted.queueAdd, remove: vi.fn() })),
  createWebhookQueue: vi.fn(() => ({})),
}));

vi.mock("@vidforge/svc-auth", () => ({
  verifyContext: vi.fn((ctx) =>
    ctx?.userId && ctx?.orgId ? { ok: true, context: ctx } : { ok: false, reason: "missing request context" },
  ),
}));

vi.mock("@vidforge/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vidforge/db")>();
  return {
    ...actual,
    prisma: {
      ...actual.prisma,
      transcodeJob: { create: vi.fn() },
    },
  };
});

import { prisma } from "@vidforge/db";
import { videoServiceImpl } from "./service.js";

const ctx = { userId: "u1", orgId: "org1", roles: ["EDITOR"], traceId: "t1", issuedAtMs: Date.now(), signature: "sig" };

function makeCall(request: Record<string, unknown>) {
  return { request } as unknown as Parameters<typeof videoServiceImpl.generateThumbnails>[0];
}

describe("generateThumbnails", () => {
  it("rejects a request missing assetId or sourceStorageKey", async () => {
    const callback = vi.fn();
    await videoServiceImpl.generateThumbnails(
      makeCall({ context: ctx, assetId: "", sourceStorageKey: "raw/video.mp4", count: 0, intervalSeconds: 0, width: 0 }),
      callback,
    );
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: status.INVALID_ARGUMENT }));
  });

  it("rejects an unauthenticated request", async () => {
    const callback = vi.fn();
    await videoServiceImpl.generateThumbnails(
      makeCall({
        context: undefined,
        assetId: "asset1",
        sourceStorageKey: "raw/video.mp4",
        count: 0,
        intervalSeconds: 0,
        width: 0,
      }),
      callback,
    );
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: status.UNAUTHENTICATED }));
  });

  it("enqueues a thumbnails-only job (empty renditions) and returns it queued", async () => {
    vi.mocked(prisma.transcodeJob.create).mockResolvedValueOnce({ id: "job1" } as never);
    hoisted.queueAdd.mockClear();

    const callback = vi.fn();
    await videoServiceImpl.generateThumbnails(
      makeCall({
        context: ctx,
        assetId: "asset1",
        sourceStorageKey: "raw/video.mp4",
        count: 5,
        intervalSeconds: 0,
        width: 480,
      }),
      callback,
    );

    expect(prisma.transcodeJob.create).toHaveBeenCalledWith({
      data: {
        assetId: "asset1",
        orgId: "org1",
        createdByUserId: "u1",
        profileJson: {
          renditions: [],
          generateThumbnails: true,
          thumbnailCount: 5,
          thumbnailIntervalSeconds: 0,
          thumbnailWidth: 480,
        },
      },
    });

    expect(hoisted.queueAdd).toHaveBeenCalledWith(
      "transcode",
      expect.objectContaining({
        jobId: "job1",
        orgId: "org1",
        assetId: "asset1",
        sourceStorageKey: "raw/video.mp4",
        profileJson: expect.objectContaining({ renditions: [] }),
      }),
      { jobId: "job1" },
    );

    expect(callback).toHaveBeenCalledWith(null, { jobId: "job1", state: JobState.JOB_STATE_QUEUED });
    expect(hoisted.publishWebhook).toHaveBeenCalledWith({
      type: "QUEUE_EVENT_TYPE_ENQUEUED",
      orgId: "org1",
      jobId: "job1",
      assetId: "asset1",
      attempt: 1,
    });
  });

  it("falls back to a default interval when neither count nor intervalSeconds is set", async () => {
    vi.mocked(prisma.transcodeJob.create).mockResolvedValueOnce({ id: "job2" } as never);

    const callback = vi.fn();
    await videoServiceImpl.generateThumbnails(
      makeCall({
        context: ctx,
        assetId: "asset1",
        sourceStorageKey: "raw/video.mp4",
        count: 0,
        intervalSeconds: 0,
        width: 0,
      }),
      callback,
    );

    expect(prisma.transcodeJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        profileJson: expect.objectContaining({
          thumbnailCount: 0,
          thumbnailIntervalSeconds: 0,
          thumbnailWidth: 320,
        }),
      }),
    });
    expect(callback).toHaveBeenCalledWith(null, { jobId: "job2", state: JobState.JOB_STATE_QUEUED });
  });

  it("returns an INTERNAL grpc error instead of crashing the process when the database call fails", async () => {
    vi.mocked(prisma.transcodeJob.create).mockRejectedValueOnce(new Error("connection refused"));

    const callback = vi.fn();
    await expect(
      videoServiceImpl.generateThumbnails(
        makeCall({
          context: ctx,
          assetId: "asset1",
          sourceStorageKey: "raw/video.mp4",
          count: 0,
          intervalSeconds: 0,
          width: 0,
        }),
        callback,
      ),
    ).resolves.toBeUndefined();

    expect(callback).toHaveBeenCalledTimes(1);
    const [err] = callback.mock.calls[0];
    expect(err).toMatchObject({ code: status.INTERNAL });
  });
});
