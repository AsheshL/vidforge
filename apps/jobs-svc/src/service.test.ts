import { status } from "@grpc/grpc-js";
import { describe, expect, it, vi } from "vitest";

const { getJobsMock, queueEventsOnMock, queueEventsOffMock } = vi.hoisted(() => ({
  getJobsMock: vi.fn(),
  queueEventsOnMock: vi.fn(),
  queueEventsOffMock: vi.fn(),
}));

vi.mock("@vidforge/queue", async (importOriginal) => ({
  WEBHOOK_EVENT_TYPES: (await importOriginal<typeof import("@vidforge/queue")>()).WEBHOOK_EVENT_TYPES,
  TRANSCODE_QUEUE: "transcode",
  createRedis: vi.fn(() => ({})),
  createTranscodeQueue: vi.fn(() => ({ getJobs: getJobsMock })),
}));

vi.mock("bullmq", () => ({
  QueueEvents: vi.fn().mockImplementation(() => ({
    on: queueEventsOnMock,
    off: queueEventsOffMock,
  })),
}));

vi.mock("@vidforge/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vidforge/db")>();
  return {
    ...actual,
    prisma: {
      ...actual.prisma,
      transcodeJob: {
        count: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
      webhook: {
        create: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        delete: vi.fn(),
      },
    },
  };
});

import { prisma } from "@vidforge/db";
import { signContext } from "@vidforge/svc-auth";
import { QueueEventType } from "@vidforge/proto/jobs";
import type { RequestContext } from "@vidforge/proto/common";
import { jobQueueServiceImpl } from "./service.js";

function signedContext(overrides: Partial<Omit<RequestContext, "issuedAtMs" | "signature">> = {}) {
  return signContext({ userId: "user-1", orgId: "org-1", roles: ["OWNER"], traceId: "trace-1", ...overrides });
}

describe("getQueueStats", () => {
  it("rejects a request with no gateway-signed context", async () => {
    const callback = vi.fn();
    await jobQueueServiceImpl.getQueueStats({ request: { context: undefined } } as never, callback);
    expect(callback).toHaveBeenCalledTimes(1);
    const [err] = callback.mock.calls[0];
    expect(err).toMatchObject({ code: status.UNAUTHENTICATED });
  });

  it("scopes live queued/active counts to the caller's org via the BullMQ job payload", async () => {
    getJobsMock.mockImplementation(async (types: string[]) => {
      if (types.includes("waiting")) {
        return [{ data: { orgId: "org-1" } }, { data: { orgId: "org-2" } }, { data: { orgId: "org-1" } }];
      }
      return [{ data: { orgId: "org-1" } }, { data: { orgId: "org-2" } }];
    });
    vi.mocked(prisma.transcodeJob.count).mockResolvedValue(0);
    vi.mocked(prisma.transcodeJob.findMany).mockResolvedValue([]);

    const callback = vi.fn();
    await jobQueueServiceImpl.getQueueStats({ request: { context: signedContext() } } as never, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    const [err, res] = callback.mock.calls[0];
    expect(err).toBeNull();
    expect(res.queued).toBe(2);
    expect(res.active).toBe(1);
  });

  it("computes 24h averages from submittedAt/startedAt/finishedAt on TranscodeJob rows", async () => {
    getJobsMock.mockResolvedValue([]);
    vi.mocked(prisma.transcodeJob.count).mockResolvedValue(1);
    const now = Date.now();
    vi.mocked(prisma.transcodeJob.findMany).mockResolvedValue([
      { submittedAt: new Date(now - 20_000), startedAt: new Date(now - 10_000), finishedAt: new Date(now) },
    ] as never);

    const callback = vi.fn();
    await jobQueueServiceImpl.getQueueStats({ request: { context: signedContext() } } as never, callback);

    const [, res] = callback.mock.calls[0];
    expect(res.avgWaitSeconds).toBeCloseTo(10);
    expect(res.avgProcessingSeconds).toBeCloseTo(10);
    expect(res.completed24h).toBe(1);
  });
});

describe("registerWebhook", () => {
  it("rejects a non-http(s) url", async () => {
    const callback = vi.fn();
    await jobQueueServiceImpl.registerWebhook(
      {
        request: {
          context: signedContext(),
          url: "not-a-url",
          events: [QueueEventType.QUEUE_EVENT_TYPE_COMPLETED],
        },
      } as never,
      callback,
    );
    const [err] = callback.mock.calls[0];
    expect(err).toMatchObject({ code: status.INVALID_ARGUMENT });
  });

  it("rejects an empty event list", async () => {
    const callback = vi.fn();
    await jobQueueServiceImpl.registerWebhook(
      { request: { context: signedContext(), url: "https://example.com/hook", events: [] } } as never,
      callback,
    );
    const [err] = callback.mock.calls[0];
    expect(err).toMatchObject({ code: status.INVALID_ARGUMENT });
  });

  it("rejects PROGRESS, which webhooks don't deliver", async () => {
    const callback = vi.fn();
    await jobQueueServiceImpl.registerWebhook(
      {
        request: {
          context: signedContext(),
          url: "https://example.com/hook",
          events: [QueueEventType.QUEUE_EVENT_TYPE_COMPLETED, QueueEventType.QUEUE_EVENT_TYPE_PROGRESS],
        },
      } as never,
      callback,
    );
    const [err] = callback.mock.calls[0];
    expect(err).toMatchObject({ code: status.INVALID_ARGUMENT });
    expect(err.details).toContain("QUEUE_EVENT_TYPE_PROGRESS");
  });

  it.each(["http://169.254.169.254/latest/meta-data", "http://10.0.0.5/hook", "http://localhost:8080/hook"])(
    "rejects an internal target %s",
    async (url) => {
      const callback = vi.fn();
      await jobQueueServiceImpl.registerWebhook(
        { request: { context: signedContext(), url, events: [QueueEventType.QUEUE_EVENT_TYPE_COMPLETED] } } as never,
        callback,
      );
      const [err] = callback.mock.calls[0];
      expect(err).toMatchObject({ code: status.INVALID_ARGUMENT });
    },
  );

  it("generates a signing secret and returns only its last 4 chars as the hint", async () => {
    vi.mocked(prisma.webhook.create).mockImplementation(
      (({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: "wh-1",
          orgId: data.orgId,
          url: data.url,
          events: data.events,
          signingSecret: data.signingSecret,
          active: data.active,
          createdAt: new Date(),
        })) as never,
    );

    const callback = vi.fn();
    await jobQueueServiceImpl.registerWebhook(
      {
        request: {
          context: signedContext(),
          url: "https://example.com/hook",
          events: [QueueEventType.QUEUE_EVENT_TYPE_COMPLETED, QueueEventType.QUEUE_EVENT_TYPE_FAILED],
        },
      } as never,
      callback,
    );

    expect(callback).toHaveBeenCalledTimes(1);
    const [err, res] = callback.mock.calls[0];
    expect(err).toBeNull();
    expect(res.webhookId).toBe("wh-1");
    expect(res.signingSecretHint).toHaveLength(4);

    const created = vi.mocked(prisma.webhook.create).mock.calls[0][0] as { data: Record<string, unknown> };
    expect(String(created.data.signingSecret).endsWith(res.signingSecretHint)).toBe(true);
    expect(created.data.events).toEqual(["QUEUE_EVENT_TYPE_COMPLETED", "QUEUE_EVENT_TYPE_FAILED"]);
    expect(created.data.orgId).toBe("org-1");
  });
});

describe("listWebhooks", () => {
  it("scopes the list to the caller's org", async () => {
    vi.mocked(prisma.webhook.findMany).mockResolvedValue([
      {
        id: "wh-1",
        orgId: "org-1",
        url: "https://example.com/a",
        events: ["QUEUE_EVENT_TYPE_COMPLETED"],
        signingSecret: "whsec_abcdef1234",
        active: true,
      },
    ] as never);

    const callback = vi.fn();
    await jobQueueServiceImpl.listWebhooks({ request: { context: signedContext() } } as never, callback);

    expect(prisma.webhook.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: "org-1" } }),
    );
    const [err, res] = callback.mock.calls[0];
    expect(err).toBeNull();
    expect(res.webhooks).toHaveLength(1);
    expect(res.webhooks[0].signingSecretHint).toBe("1234");
    expect(res.webhooks[0].events).toEqual([QueueEventType.QUEUE_EVENT_TYPE_COMPLETED]);
  });
});

describe("deleteWebhook", () => {
  it("returns NOT_FOUND for a webhook belonging to a different org", async () => {
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue({ id: "wh-1", orgId: "org-2" } as never);

    const callback = vi.fn();
    await jobQueueServiceImpl.deleteWebhook(
      { request: { context: signedContext(), webhookId: "wh-1" } } as never,
      callback,
    );

    const [err] = callback.mock.calls[0];
    expect(err).toMatchObject({ code: status.NOT_FOUND });
    expect(prisma.webhook.delete).not.toHaveBeenCalled();
  });

  it("deletes a webhook that belongs to the caller's org", async () => {
    vi.mocked(prisma.webhook.findUnique).mockResolvedValue({ id: "wh-1", orgId: "org-1" } as never);
    vi.mocked(prisma.webhook.delete).mockResolvedValue({} as never);

    const callback = vi.fn();
    await jobQueueServiceImpl.deleteWebhook(
      { request: { context: signedContext(), webhookId: "wh-1" } } as never,
      callback,
    );

    expect(prisma.webhook.delete).toHaveBeenCalledWith({ where: { id: "wh-1" } });
    const [err, res] = callback.mock.calls[0];
    expect(err).toBeNull();
    expect(res.deleted).toBe(true);
  });
});

describe("getUsage", () => {
  it("sums completed job durations into transcode_minutes and leaves storage/egress at 0", async () => {
    const now = Date.now();
    vi.mocked(prisma.transcodeJob.findMany).mockResolvedValue([
      { startedAt: new Date(now - 120_000), finishedAt: new Date(now) },
      { startedAt: new Date(now - 60_000), finishedAt: new Date(now) },
    ] as never);

    const callback = vi.fn();
    await jobQueueServiceImpl.getUsage(
      {
        request: { context: signedContext(), from: new Date(now - 86_400_000), to: new Date(now) },
      } as never,
      callback,
    );

    expect(callback).toHaveBeenCalledTimes(1);
    const [err, res] = callback.mock.calls[0];
    expect(err).toBeNull();
    expect(res.orgId).toBe("org-1");
    expect(res.transcodeMinutes).toBeCloseTo(3);
    expect(res.jobsCompleted).toBe(2);
    // Not derivable from the current schema — see the comment in
    // getUsage's implementation.
    expect(res.storageBytes).toBe(0);
    expect(res.egressBytes).toBe(0);
  });
});
