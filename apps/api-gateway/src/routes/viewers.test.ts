import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("../auth.js", () => ({
  authClient: { inviteViewer: vi.fn(), listViewers: vi.fn(), revokeViewer: vi.fn() },
  requireRole: () => async (req: { authContext?: unknown }) => {
    req.authContext = { orgId: "org-1", userId: "admin-1", roles: ["ADMIN"] };
  },
}));

import { authClient } from "../auth.js";
import { registerViewerRoutes } from "./viewers.js";

function buildApp() {
  const app = Fastify();
  registerViewerRoutes(app);
  return app;
}

describe("POST /v1/viewers/invite", () => {
  it("validates the email", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/viewers/invite", payload: { email: "not-an-email" } });
    expect(res.statusCode).toBe(400);
  });

  it("forwards to InviteViewer and returns 201 on success", async () => {
    vi.mocked(authClient.inviteViewer).mockImplementationOnce((_req, cb: any) =>
      cb(null, { viewerId: "v1", orgId: "org-1", email: "v@example.com" } as never),
    );
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/viewers/invite", payload: { email: "v@example.com" } });
    expect(res.statusCode).toBe(201);
  });

  it("maps ALREADY_EXISTS (re-inviting an activated viewer) to 409", async () => {
    vi.mocked(authClient.inviteViewer).mockImplementationOnce((_req, cb: any) =>
      cb(Object.assign(new Error("x"), { code: 6, details: "already activated" }), undefined as never),
    );
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/viewers/invite", payload: { email: "v@example.com" } });
    expect(res.statusCode).toBe(409);
  });
});

describe("POST /v1/viewers/:viewerId/revoke", () => {
  it("maps NOT_FOUND to 404", async () => {
    vi.mocked(authClient.revokeViewer).mockImplementationOnce((_req, cb: any) =>
      cb(Object.assign(new Error("x"), { code: 5, details: "no such viewer" }), undefined as never),
    );
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/viewers/v1/revoke" });
    expect(res.statusCode).toBe(404);
  });
});
