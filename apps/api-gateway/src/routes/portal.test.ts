import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("@vidforge/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vidforge/db")>();
  return {
    ...actual,
    prisma: {
      ...actual.prisma,
      org: { findUnique: vi.fn() },
      asset: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() },
      transcodeJob: { findFirst: vi.fn() },
    },
  };
});

vi.mock("../auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth.js")>();
  return {
    ...actual,
    authClient: { activateViewer: vi.fn(), viewerLogin: vi.fn() },
    requireViewer: () => async (req: { viewerContext?: unknown }) => {
      req.viewerContext = { viewerId: "v1", orgId: "org1" };
    },
    viewerToInternalContext: () => ({
      userId: "v1", orgId: "org1", roles: ["VIEWER"], traceId: "t", issuedAtMs: 0, signature: "s",
    }),
  };
});

vi.mock("./playback.js", () => ({
  presign: vi.fn().mockResolvedValue("https://signed.example/logo.png"),
  fetchHlsPlaylist: vi.fn(),
  fetchThumbnailUrls: vi.fn(),
  SIGNED_URL_TTL_SECONDS: 900,
}));

import { prisma } from "@vidforge/db";
import { authClient } from "../auth.js";
import { registerPortalRoutes } from "./portal.js";

function buildApp() {
  const app = Fastify();
  registerPortalRoutes(app, {} as never);
  return app;
}

describe("GET /v1/portal/org/:orgSlug", () => {
  it("404s for an unknown slug", async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/portal/org/nope" });
    expect(res.statusCode).toBe(404);
  });

  it("returns displayName (falling back to name) and a presigned logo URL", async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({
      displayName: null, name: "Acme", logoStorageKey: "org-logos/x.png",
    } as never);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/portal/org/acme" });
    expect(res.json()).toEqual({ displayName: "Acme", logoUrl: "https://signed.example/logo.png" });
  });
});

describe("POST /v1/portal/auth/login", () => {
  it("validates the body", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/portal/auth/login", payload: { orgSlug: "acme" } });
    expect(res.statusCode).toBe(400);
  });

  it("forwards to ViewerLogin and maps UNAUTHENTICATED to 401", async () => {
    vi.mocked(authClient.viewerLogin).mockImplementationOnce((_req, cb: any) =>
      cb(Object.assign(new Error("bad"), { code: 16, details: "invalid email or password" }), undefined as never),
    );
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/portal/auth/login",
      payload: { orgSlug: "acme", email: "a@b.com", password: "x" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /v1/portal/library", () => {
  it("only returns published assets, scoped to the viewer's org", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.asset.count).mockResolvedValueOnce(0);
    const app = buildApp();
    await app.inject({ method: "GET", url: "/v1/portal/library" });
    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orgId: "org1", publishedAt: { not: null } }),
      }),
    );
  });

  it("filters by title when q is given", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.asset.count).mockResolvedValueOnce(0);
    const app = buildApp();
    await app.inject({ method: "GET", url: "/v1/portal/library?q=dragon" });
    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ title: { contains: "dragon", mode: "insensitive" } }),
      }),
    );
  });
});

describe("GET /v1/portal/jobs/:jobId/hls/*", () => {
  it("404s when the job's asset isn't published in the viewer's org", async () => {
    vi.mocked(prisma.transcodeJob.findFirst).mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/portal/jobs/job1/hls/master.m3u8" });
    expect(res.statusCode).toBe(404);
  });
});
