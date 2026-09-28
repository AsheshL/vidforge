import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("@vidforge/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vidforge/db")>();
  return {
    ...actual,
    prisma: {
      ...actual.prisma,
      asset: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    },
  };
});

vi.mock("../auth.js", () => ({
  // Bypasses the real gRPC round-trip to auth-svc; every request is
  // authenticated as the same fake org so we can focus on pagination.
  requireRole: () => async (req: { authContext?: unknown }) => {
    req.authContext = { orgId: "org-1", userId: "user-1", roles: ["VIEWER"] };
  },
  authClient: {
    recordAuditEvent: vi.fn((_req, cb: any) => cb(null, { eventId: "event-1" })),
  },
}));

import { prisma } from "@vidforge/db";
import { authClient } from "../auth.js";
import { registerAssetRoutes } from "./assets.js";

function buildApp() {
  const app = Fastify();
  registerAssetRoutes(app);
  return app;
}

// Only the fields the route actually reads; findMany's mocked return type
// is widened to match since the real payload also carries org/version/etc.
function makeAsset(id: string): Awaited<ReturnType<typeof prisma.asset.findMany>>[number] {
  return {
    id,
    title: `asset ${id}`,
    status: "READY",
    sourceStorageKey: "key",
    sourceBytes: 1024n,
    durationSeconds: 12,
    createdBy: "user-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    publishedAt: null,
    jobs: [],
  } as unknown as Awaited<ReturnType<typeof prisma.asset.findMany>>[number];
}

describe("GET /v1/assets", () => {
  it("clamps pageSize into [1, 100] with a default of 50, mirroring ListJobs", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.asset.count).mockResolvedValueOnce(0);
    const app = buildApp();

    await app.inject({ method: "GET", url: "/v1/assets" });

    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );

    vi.mocked(prisma.asset.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.asset.count).mockResolvedValueOnce(0);
    await app.inject({ method: "GET", url: "/v1/assets?pageSize=500" });
    expect(prisma.asset.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 100 }),
    );

    vi.mocked(prisma.asset.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.asset.count).mockResolvedValueOnce(0);
    await app.inject({ method: "GET", url: "/v1/assets?pageSize=-5" });
    expect(prisma.asset.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 1 }),
    );
  });

  it("orders by (createdAt, id) desc and scopes the query to the caller's org", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.asset.count).mockResolvedValueOnce(0);
    const app = buildApp();

    await app.inject({ method: "GET", url: "/v1/assets" });

    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: "org-1" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }),
    );
    expect(prisma.asset.count).toHaveBeenCalledWith({ where: { orgId: "org-1" } });
  });

  it("forwards pageToken as a cursor with skip: 1, like ListJobs", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.asset.count).mockResolvedValueOnce(0);
    const app = buildApp();

    await app.inject({ method: "GET", url: "/v1/assets?pageToken=asset-42" });

    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: "asset-42" }, skip: 1 }),
    );
  });

  it("returns nextPageToken as the last row's id only when the page is full, plus totalCount", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValueOnce([makeAsset("a1"), makeAsset("a2")]);
    vi.mocked(prisma.asset.count).mockResolvedValueOnce(2);
    const app = buildApp();

    const full = await app.inject({ method: "GET", url: "/v1/assets?pageSize=2" });
    expect(full.json().pageInfo).toEqual({ nextPageToken: "a2", totalCount: 2 });

    vi.mocked(prisma.asset.findMany).mockResolvedValueOnce([makeAsset("a1")]);
    vi.mocked(prisma.asset.count).mockResolvedValueOnce(1);
    const partial = await app.inject({ method: "GET", url: "/v1/assets?pageSize=2" });
    expect(partial.json().pageInfo).toEqual({ nextPageToken: "", totalCount: 1 });
  });

  it("maps asset fields and serializes BigInt sourceBytes to a number", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValueOnce([makeAsset("a1")]);
    vi.mocked(prisma.asset.count).mockResolvedValueOnce(1);
    const app = buildApp();

    const res = await app.inject({ method: "GET", url: "/v1/assets" });

    expect(res.json().assets).toEqual([
      {
        assetId: "a1",
        title: "asset a1",
        status: "READY",
        sourceStorageKey: "key",
        sourceBytes: 1024,
        durationSeconds: 12,
        createdBy: "user-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        publishedAt: null,
        latestCompletedJobId: null,
      },
    ]);
  });

  it("includes publishedAt so the staff UI can reflect current publish state", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValueOnce([
      { ...makeAsset("a1"), publishedAt: new Date("2026-02-01T00:00:00Z") },
    ]);
    vi.mocked(prisma.asset.count).mockResolvedValueOnce(1);
    const app = buildApp();

    const res = await app.inject({ method: "GET", url: "/v1/assets" });

    expect(res.json().assets[0].publishedAt).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("PATCH /v1/assets/:id/publish", () => {
  it("404s for an asset in a different org", async () => {
    vi.mocked(prisma.asset.findFirst).mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await app.inject({
      method: "PATCH", url: "/v1/assets/a1/publish", payload: { published: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("sets publishedAt when publishing", async () => {
    vi.mocked(prisma.asset.findFirst).mockResolvedValueOnce({ id: "a1", orgId: "org-1" } as never);
    vi.mocked(prisma.asset.update).mockResolvedValueOnce({ id: "a1", publishedAt: new Date("2026-09-28") } as never);
    const app = buildApp();
    const res = await app.inject({
      method: "PATCH", url: "/v1/assets/a1/publish", payload: { published: true },
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { publishedAt: expect.any(Date) } });
  });

  it("clears publishedAt when unpublishing", async () => {
    vi.mocked(prisma.asset.findFirst).mockResolvedValueOnce({ id: "a1", orgId: "org-1" } as never);
    vi.mocked(prisma.asset.update).mockResolvedValueOnce({ id: "a1", publishedAt: null } as never);
    const app = buildApp();
    await app.inject({ method: "PATCH", url: "/v1/assets/a1/publish", payload: { published: false } });
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { publishedAt: null } });
  });

  it("records an audit event — publishing an asset is the most consequential action in the feature", async () => {
    vi.mocked(prisma.asset.findFirst).mockResolvedValueOnce({ id: "a1", orgId: "org-1" } as never);
    vi.mocked(prisma.asset.update).mockResolvedValueOnce({ id: "a1", publishedAt: new Date("2026-09-28") } as never);
    const app = buildApp();
    await app.inject({ method: "PATCH", url: "/v1/assets/a1/publish", payload: { published: true } });
    expect(authClient.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "asset.publish", resourceType: "asset", resourceId: "a1" }),
      expect.any(Function),
    );
  });
});
