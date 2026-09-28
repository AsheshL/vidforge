import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("@vidforge/proto/auth", () => ({
  AuthServiceClient: vi.fn().mockImplementation(() => ({
    verifyToken: vi.fn((_req, cb) => cb(null, { valid: false, context: undefined, viewerContext: undefined })),
  })),
}));

import { authClient, requireRole, requireViewer, viewerToInternalContext } from "./auth.js";

describe("requireRole", () => {
  it("401s when VerifyToken returns a viewerContext instead of a staff context (cross-contamination guard, viewer token vs. requireRole)", async () => {
    vi.mocked(authClient.verifyToken).mockImplementationOnce((_req, cb: any) =>
      cb(null, { valid: true, context: undefined, viewerContext: { viewerId: "v1", orgId: "org1" } } as never),
    );
    const app = Fastify();
    app.get("/protected", { preHandler: requireRole("VIEWER") }, async () => ({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/protected", headers: { authorization: "Bearer viewer-token" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("requireViewer", () => {
  it("401s when VerifyToken returns no viewerContext (e.g. a staff token)", async () => {
    vi.mocked(authClient.verifyToken).mockImplementationOnce((_req, cb: any) =>
      cb(null, { valid: true, context: { userId: "u1", orgId: "org1", roles: ["ADMIN"] }, viewerContext: undefined } as never),
    );
    const app = Fastify();
    app.get("/protected", { preHandler: requireViewer() }, async () => ({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/protected", headers: { authorization: "Bearer staff-token" } });
    expect(res.statusCode).toBe(401);
  });

  it("sets req.viewerContext when VerifyToken returns one", async () => {
    vi.mocked(authClient.verifyToken).mockImplementationOnce((_req, cb: any) =>
      cb(null, { valid: true, context: undefined, viewerContext: { viewerId: "v1", orgId: "org1" } } as never),
    );
    const app = Fastify();
    app.get("/protected", { preHandler: requireViewer() }, async (req) => ({ viewer: req.viewerContext }));
    const res = await app.inject({ method: "GET", url: "/protected", headers: { authorization: "Bearer viewer-token" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ viewer: { viewerId: "v1", orgId: "org1" } });
  });
});

describe("viewerToInternalContext", () => {
  it("produces a signed RequestContext scoped to the viewer's org with the lowest staff rank", () => {
    vi.stubEnv("CONTEXT_SIGNING_SECRET", "test-secret");
    const ctx = viewerToInternalContext({ viewerId: "v1", orgId: "org1" }, "trace1");
    expect(ctx).toMatchObject({ userId: "v1", orgId: "org1", roles: ["VIEWER"], traceId: "trace1" });
    expect(ctx.signature).toBeTruthy();
    vi.unstubAllEnvs();
  });
});
