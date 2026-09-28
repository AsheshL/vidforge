import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("@vidforge/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vidforge/db")>();
  return { ...actual, prisma: { ...actual.prisma, org: { update: vi.fn(), findUnique: vi.fn() } } };
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: vi.fn().mockResolvedValue({}) })),
  PutObjectCommand: vi.fn(),
}));

vi.mock("./playback.js", () => ({
  presign: vi.fn().mockResolvedValue("https://signed.example/logo.png"),
}));

vi.mock("../auth.js", () => ({
  authClient: {
    recordAuditEvent: vi.fn((_req, cb: any) => cb(null, { eventId: "event-1" })),
  },
  requireRole: () => async (req: { authContext?: unknown }) => {
    req.authContext = { orgId: "org-1", userId: "admin-1", roles: ["ADMIN"] };
  },
}));

import { prisma } from "@vidforge/db";
import { authClient } from "../auth.js";
import { presign } from "./playback.js";
import { registerOrgRoutes } from "./org.js";

function buildApp() {
  const app = Fastify();
  registerOrgRoutes(app);
  return app;
}

describe("PATCH /v1/org", () => {
  it("updates displayName alone", async () => {
    vi.mocked(prisma.org.update).mockResolvedValueOnce({ displayName: "Acme Streaming", logoStorageKey: null } as never);
    const app = buildApp();
    const res = await app.inject({ method: "PATCH", url: "/v1/org", payload: { displayName: "Acme Streaming" } });
    expect(res.statusCode).toBe(200);
    expect(prisma.org.update).toHaveBeenCalledWith({ where: { id: "org-1" }, data: { displayName: "Acme Streaming" } });
  });

  it("records an audit event for the identity change", async () => {
    vi.mocked(prisma.org.update).mockResolvedValueOnce({ displayName: "Acme Streaming", logoStorageKey: null } as never);
    const app = buildApp();
    await app.inject({ method: "PATCH", url: "/v1/org", payload: { displayName: "Acme Streaming" } });
    expect(authClient.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "org.update_identity", resourceType: "org", resourceId: "org-1" }),
      expect.any(Function),
    );
  });

  it("rejects a non-image data URI for the logo", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "PATCH", url: "/v1/org", payload: { logoDataUri: "data:text/plain;base64,aGVsbG8=" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a logo over 2MB", async () => {
    const bigBase64 = Buffer.alloc(3 * 1024 * 1024, 1).toString("base64");
    const app = buildApp();
    const res = await app.inject({
      method: "PATCH", url: "/v1/org", payload: { logoDataUri: `data:image/png;base64,${bigBase64}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /v1/org", () => {
  it("returns the org's current identity, presigning the logo if set", async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({
      name: "Acme Inc", slug: "acme-inc", displayName: "Acme Streaming", logoStorageKey: "org-logos/org-1-abc.png",
    } as never);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/org" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: "Acme Inc", slug: "acme-inc", displayName: "Acme Streaming", logoUrl: "https://signed.example/logo.png",
    });
    expect(presign).toHaveBeenCalledWith("org-logos/org-1-abc.png");
  });

  it("returns a null logoUrl when no logo is set", async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({
      name: "Acme Inc", slug: "acme-inc", displayName: null, logoStorageKey: null,
    } as never);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/org" });
    expect(res.json()).toEqual({ name: "Acme Inc", slug: "acme-inc", displayName: null, logoUrl: null });
  });
});
