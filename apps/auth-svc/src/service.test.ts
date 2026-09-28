import { status } from "@grpc/grpc-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("@vidforge/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vidforge/db")>();
  return {
    ...actual,
    prisma: {
      ...actual.prisma,
      user: { findUnique: vi.fn() },
      org: { findUnique: vi.fn() },
      apiKey: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() },
      viewer: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
      auditEvent: { create: vi.fn() },
      $transaction: vi.fn(),
    },
  };
});

vi.mock("./mailer.js", () => ({
  sendInviteEmail: vi.fn(),
  sendViewerInviteEmail: vi.fn(),
}));

import { prisma } from "@vidforge/db";
import { Role } from "@vidforge/proto/auth";
import { signContext } from "@vidforge/svc-auth";
import { authServiceImpl } from "./service.js";
import { hashPassword } from "./password.js";
import { sendViewerInviteEmail } from "./mailer.js";
import { signToken, signViewerActivationToken, signViewerToken } from "./jwt.js";

const staffCtx = signContext({ userId: "admin1", orgId: "org1", roles: ["ADMIN"], traceId: "t1" });

describe("signUp", () => {
  it("returns an INTERNAL grpc error instead of crashing the process when the database call fails", async () => {
    // Same failure this hit in production: migrations hadn't run yet, so
    // the very first query threw. signUp had no try/catch (unlike
    // verifyToken just above it in service.ts), so that exception went
    // out as an unhandled rejection and took the whole process down —
    // not just this one request.
    vi.mocked(prisma.user.findUnique).mockRejectedValueOnce(
      new Error("The table `public.User` does not exist in the current database."),
    );

    const callback = vi.fn();
    const call = {
      request: {
        email: "smoke-test@example.com",
        password: "smoketestpassword123",
        displayName: "Smoke Test",
        orgName: "",
      },
    } as Parameters<typeof authServiceImpl.signUp>[0];

    await expect(authServiceImpl.signUp(call, callback)).resolves.toBeUndefined();

    expect(callback).toHaveBeenCalledTimes(1);
    const [err] = callback.mock.calls[0];
    expect(err).toMatchObject({ code: status.INTERNAL });
  });
});

describe("signUp org slug", () => {
  it("derives a url-safe slug from the org name", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce(null); // no collision
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn) =>
      fn({
        org: { create: vi.fn().mockResolvedValue({ id: "org1", slug: "acme-inc" }) },
        user: {
          create: vi.fn().mockResolvedValue({
            id: "u1", email: "a@b.com", displayName: "A", orgId: "org1", role: "OWNER",
          }),
        },
      } as never),
    );

    const callback = vi.fn();
    const call = {
      request: { email: "a@b.com", password: "smoketestpassword123", displayName: "A", orgName: "Acme, Inc!" },
    } as Parameters<typeof authServiceImpl.signUp>[0];

    await authServiceImpl.signUp(call, callback);

    expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ token: expect.any(String) }));
  });
});

describe("login", () => {
  it("returns an INTERNAL grpc error instead of crashing the process when the database call fails", async () => {
    vi.mocked(prisma.user.findUnique).mockRejectedValueOnce(
      new Error("The table `public.User` does not exist in the current database."),
    );

    const callback = vi.fn();
    const call = {
      request: { email: "smoke-test@example.com", password: "smoketestpassword123" },
    } as Parameters<typeof authServiceImpl.login>[0];

    await expect(authServiceImpl.login(call, callback)).resolves.toBeUndefined();

    expect(callback).toHaveBeenCalledTimes(1);
    const [err] = callback.mock.calls[0];
    expect(err).toMatchObject({ code: status.INTERNAL });
  });
});

function ctxFor(roles: string[], overrides: Partial<{ userId: string; orgId: string }> = {}) {
  return signContext({
    userId: overrides.userId ?? "admin-1",
    orgId: overrides.orgId ?? "org-1",
    roles,
    traceId: "t1",
  });
}

describe("createApiKey", () => {
  it("creates a key and returns the plaintext secret exactly once", async () => {
    vi.mocked(prisma.apiKey.create).mockResolvedValueOnce({} as never);
    vi.mocked(prisma.auditEvent.create).mockResolvedValueOnce({} as never);

    const callback = vi.fn();
    const call = {
      request: { context: ctxFor(["ADMIN"]), name: "CI key", role: Role.ROLE_VIEWER, expiresAt: undefined },
    } as Parameters<typeof authServiceImpl.createApiKey>[0];

    await authServiceImpl.createApiKey(call, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    const [err, res] = callback.mock.calls[0];
    expect(err).toBeNull();
    expect(res.keyId).toBeTruthy();
    expect(res.secret).toMatch(/^vfk_/);
    expect(prisma.apiKey.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "CI key",
          role: "VIEWER",
          orgId: "org-1",
          createdBy: "admin-1",
        }),
      }),
    );
  });

  it("rejects a role above the creator's own", async () => {
    const callback = vi.fn();
    const call = {
      request: { context: ctxFor(["VIEWER"]), name: "escalate", role: Role.ROLE_ADMIN, expiresAt: undefined },
    } as Parameters<typeof authServiceImpl.createApiKey>[0];

    await authServiceImpl.createApiKey(call, callback);

    expect(callback).toHaveBeenCalledTimes(1);
    const [err] = callback.mock.calls[0];
    expect(err).toMatchObject({ code: status.PERMISSION_DENIED });
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });
});

describe("revokeApiKey", () => {
  it("revokes an existing key that belongs to the caller's org", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValueOnce({
      id: "key-1",
      orgId: "org-1",
      revokedAt: null,
    } as never);
    vi.mocked(prisma.apiKey.update).mockResolvedValueOnce({} as never);
    vi.mocked(prisma.auditEvent.create).mockResolvedValueOnce({} as never);

    const callback = vi.fn();
    const call = {
      request: { context: ctxFor(["ADMIN"]), keyId: "key-1" },
    } as Parameters<typeof authServiceImpl.revokeApiKey>[0];

    await authServiceImpl.revokeApiKey(call, callback);

    expect(callback).toHaveBeenCalledWith(null, { revoked: true });
    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: "key-1" },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("returns NOT_FOUND for a key belonging to a different org", async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValueOnce({
      id: "key-2",
      orgId: "some-other-org",
      revokedAt: null,
    } as never);

    const callback = vi.fn();
    const call = {
      request: { context: ctxFor(["ADMIN"]), keyId: "key-2" },
    } as Parameters<typeof authServiceImpl.revokeApiKey>[0];

    await authServiceImpl.revokeApiKey(call, callback);

    const [err] = callback.mock.calls[0];
    expect(err).toMatchObject({ code: status.NOT_FOUND });
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });
});

describe("listApiKeys", () => {
  it("lists an org's keys and never exposes secretHash", async () => {
    vi.mocked(prisma.apiKey.findMany).mockResolvedValueOnce([
      {
        id: "key-1",
        name: "CI",
        role: "EDITOR",
        createdBy: "admin-1",
        secretHash: "scrypt:should-never:appear-in-response",
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        orgId: "org-1",
      },
    ] as never);

    const callback = vi.fn();
    const call = {
      request: { context: ctxFor(["ADMIN"]), page: { pageSize: 50, pageToken: "" } },
    } as Parameters<typeof authServiceImpl.listApiKeys>[0];

    await authServiceImpl.listApiKeys(call, callback);

    const [err, res] = callback.mock.calls[0];
    expect(err).toBeNull();
    expect(res.apiKeys).toHaveLength(1);
    expect(res.apiKeys[0]).not.toHaveProperty("secretHash");
    expect(res.apiKeys[0]).toMatchObject({ keyId: "key-1", name: "CI", createdBy: "admin-1" });
    expect(JSON.stringify(res)).not.toContain("scrypt:should-never");
  });
});

describe("verifyToken with API keys", () => {
  it("accepts a valid, unexpired, unrevoked key", async () => {
    const keyId = "key-abc";
    const secret = `vfk_${keyId}_somerandom`;
    const secretHash = await hashPassword(secret);
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValueOnce({
      id: keyId,
      secretHash,
      role: "EDITOR",
      orgId: "org-1",
      createdBy: "user-1",
      expiresAt: null,
      revokedAt: null,
      name: "x",
      createdAt: new Date(),
    } as never);

    const callback = vi.fn();
    await authServiceImpl.verifyToken(
      { request: { token: secret } } as Parameters<typeof authServiceImpl.verifyToken>[0],
      callback,
    );

    expect(callback).toHaveBeenCalledTimes(1);
    const [err, res] = callback.mock.calls[0];
    expect(err).toBeNull();
    expect(res.valid).toBe(true);
    expect(res.context).toMatchObject({ userId: "user-1", orgId: "org-1", roles: ["EDITOR"] });
  });

  it("rejects an expired key", async () => {
    const keyId = "key-exp";
    const secret = `vfk_${keyId}_somerandom`;
    const secretHash = await hashPassword(secret);
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValueOnce({
      id: keyId,
      secretHash,
      role: "EDITOR",
      orgId: "org-1",
      createdBy: "user-1",
      expiresAt: new Date(Date.now() - 1000),
      revokedAt: null,
      name: "x",
      createdAt: new Date(),
    } as never);

    const callback = vi.fn();
    await authServiceImpl.verifyToken(
      { request: { token: secret } } as Parameters<typeof authServiceImpl.verifyToken>[0],
      callback,
    );

    expect(callback).toHaveBeenCalledWith(null, { valid: false, context: undefined, expiresAt: undefined });
  });

  it("rejects a revoked key", async () => {
    const keyId = "key-rev";
    const secret = `vfk_${keyId}_somerandom`;
    const secretHash = await hashPassword(secret);
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValueOnce({
      id: keyId,
      secretHash,
      role: "EDITOR",
      orgId: "org-1",
      createdBy: "user-1",
      expiresAt: null,
      revokedAt: new Date(),
      name: "x",
      createdAt: new Date(),
    } as never);

    const callback = vi.fn();
    await authServiceImpl.verifyToken(
      { request: { token: secret } } as Parameters<typeof authServiceImpl.verifyToken>[0],
      callback,
    );

    expect(callback).toHaveBeenCalledWith(null, { valid: false, context: undefined, expiresAt: undefined });
  });

  it("rejects a well-formed key whose secret doesn't match the stored hash", async () => {
    const keyId = "key-bad";
    const secretHash = await hashPassword(`vfk_${keyId}_the-real-secret`);
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValueOnce({
      id: keyId,
      secretHash,
      role: "EDITOR",
      orgId: "org-1",
      createdBy: "user-1",
      expiresAt: null,
      revokedAt: null,
      name: "x",
      createdAt: new Date(),
    } as never);

    const callback = vi.fn();
    await authServiceImpl.verifyToken(
      { request: { token: `vfk_${keyId}_wrong-secret` } } as Parameters<typeof authServiceImpl.verifyToken>[0],
      callback,
    );

    expect(callback).toHaveBeenCalledWith(null, { valid: false, context: undefined, expiresAt: undefined });
  });
});

describe("inviteViewer", () => {
  it("rejects callers below ADMIN", async () => {
    const ctx = signContext({ userId: "u1", orgId: "org1", roles: ["EDITOR"], traceId: "t1" });
    const callback = vi.fn();
    await authServiceImpl.inviteViewer(
      { request: { context: ctx, email: "viewer@example.com" } } as never,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: status.PERMISSION_DENIED }));
  });

  it("creates a pending viewer and emails an activation link", async () => {
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.viewer.create).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", email: "viewer@example.com",
      invitedAt: new Date(), activatedAt: null, revokedAt: null,
    } as never);
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({ id: "org1", name: "Acme", slug: "acme", displayName: null } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: "admin1", displayName: "Ada Admin" } as never);

    const callback = vi.fn();
    await authServiceImpl.inviteViewer(
      { request: { context: staffCtx, email: "viewer@example.com" } } as never,
      callback,
    );

    expect(sendViewerInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "viewer@example.com", orgName: "Acme" }),
    );
    expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ email: "viewer@example.com" }));
  });

  it("rejects re-inviting an already-activated viewer as a no-op", async () => {
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", email: "viewer@example.com", activatedAt: new Date(),
    } as never);
    const callback = vi.fn();
    await authServiceImpl.inviteViewer(
      { request: { context: staffCtx, email: "viewer@example.com" } } as never,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: status.ALREADY_EXISTS }));
  });
});

describe("revokeViewer", () => {
  it("404s for a viewer in a different org", async () => {
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({ id: "v1", orgId: "org-other" } as never);
    const callback = vi.fn();
    await authServiceImpl.revokeViewer({ request: { context: staffCtx, viewerId: "v1" } } as never, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: status.NOT_FOUND }));
  });

  it("sets revokedAt for a viewer in the caller's org", async () => {
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({ id: "v1", orgId: "org1" } as never);
    vi.mocked(prisma.viewer.update).mockResolvedValueOnce({} as never);
    const callback = vi.fn();
    await authServiceImpl.revokeViewer({ request: { context: staffCtx, viewerId: "v1" } } as never, callback);
    expect(prisma.viewer.update).toHaveBeenCalledWith({
      where: { id: "v1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(callback).toHaveBeenCalledWith(null, { revoked: true });
  });
});

describe("activateViewer", () => {
  it("rejects an expired or malformed token", async () => {
    const callback = vi.fn();
    await authServiceImpl.activateViewer(
      { request: { orgSlug: "acme", token: "garbage", password: "longenoughpassword" } } as never,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: status.UNAUTHENTICATED }));
  });

  it("rejects activating an already-activated account", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signViewerActivationToken({ sub: "viewer1" });
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", activatedAt: new Date(), revokedAt: null,
    } as never);
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({ id: "org1", slug: "acme" } as never);

    const callback = vi.fn();
    await authServiceImpl.activateViewer(
      { request: { orgSlug: "acme", token, password: "longenoughpassword" } } as never,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: status.ALREADY_EXISTS }));
  });

  it("activates a pending viewer and returns a session", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signViewerActivationToken({ sub: "viewer1" });
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", activatedAt: null, revokedAt: null,
    } as never);
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({ id: "org1", slug: "acme" } as never);
    vi.mocked(prisma.viewer.update).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", email: "v@example.com", invitedAt: new Date(), activatedAt: new Date(),
    } as never);

    const callback = vi.fn();
    await authServiceImpl.activateViewer(
      { request: { orgSlug: "acme", token, password: "longenoughpassword" } } as never,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ token: expect.any(String) }));
  });
});

describe("verifyToken — viewer tokens", () => {
  it("returns a ViewerContext, never a staff context, for a viewer token", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signViewerToken({ sub: "viewer1", org: "org1" });
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", activatedAt: new Date(), revokedAt: null,
    } as never);

    const callback = vi.fn();
    await authServiceImpl.verifyToken({ request: { token } } as never, callback);

    expect(callback).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ valid: true, context: undefined, viewerContext: { viewerId: "viewer1", orgId: "org1" } }),
    );
  });

  it("rejects a viewer token for a viewer that no longer exists", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signViewerToken({ sub: "viewer1", org: "org1" });
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce(null);

    const callback = vi.fn();
    await authServiceImpl.verifyToken({ request: { token } } as never, callback);

    expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ valid: false }));
  });

  it("rejects an already-issued session token the instant the viewer is revoked — revocation isn't just a login-time check", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signViewerToken({ sub: "viewer1", org: "org1" });
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", activatedAt: new Date("2026-01-01"), revokedAt: new Date("2026-09-28"),
    } as never);

    const callback = vi.fn();
    await authServiceImpl.verifyToken({ request: { token } } as never, callback);

    expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ valid: false }));
  });

  it("a staff token never resolves to a ViewerContext (cross-contamination guard)", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signToken({ sub: "user1", org: "org1", role: "ADMIN" });
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: "user1", orgId: "org1", role: "ADMIN", mustChangePassword: false,
    } as never);

    const callback = vi.fn();
    await authServiceImpl.verifyToken({ request: { token } } as never, callback);

    const [, res] = callback.mock.calls[0];
    expect(res.viewerContext).toBeUndefined();
    expect(res.context).toBeDefined();
  });
});

describe("viewerLogin", () => {
  it("rejects a revoked viewer even with the correct password", async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({ id: "org1", slug: "acme" } as never);
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", passwordHash: await hashPassword("correcthorsebattery"), revokedAt: new Date(),
    } as never);

    const callback = vi.fn();
    await authServiceImpl.viewerLogin(
      { request: { orgSlug: "acme", email: "v@example.com", password: "correcthorsebattery" } } as never,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: status.UNAUTHENTICATED }));
  });

  it("logs in an activated, non-revoked viewer", async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({ id: "org1", slug: "acme" } as never);
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", email: "v@example.com",
      passwordHash: await hashPassword("correcthorsebattery"), revokedAt: null,
      invitedAt: new Date(), activatedAt: new Date(),
    } as never);

    const callback = vi.fn();
    await authServiceImpl.viewerLogin(
      { request: { orgSlug: "acme", email: "v@example.com", password: "correcthorsebattery" } } as never,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ token: expect.any(String) }));
  });
});
