import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { QueueEventType, type JobQueueServiceClient } from "@vidforge/proto/jobs";

vi.mock("../auth.js", () => ({
  // Bypasses the real gRPC round-trip to auth-svc; role enforcement itself
  // is requireRole's job and is exercised end to end elsewhere.
  requireRole: () => async (req: { authContext?: unknown }) => {
    req.authContext = { orgId: "org-1", userId: "user-1", roles: ["ADMIN"] };
  },
}));

import { registerWebhookRoutes } from "./webhooks.js";

const webhook = {
  webhookId: "wh-1",
  orgId: "org-1",
  url: "https://example.com/hook",
  events: [QueueEventType.QUEUE_EVENT_TYPE_COMPLETED, QueueEventType.QUEUE_EVENT_TYPE_FAILED],
  signingSecretHint: "beef",
  active: true,
  signingSecret: "",
};

function buildApp(client: Partial<Record<keyof JobQueueServiceClient, unknown>>) {
  const app = Fastify();
  registerWebhookRoutes(app, client as unknown as JobQueueServiceClient);
  return app;
}

const grpcErr = (code: number, details: string) => Object.assign(new Error(details), { code, details });

describe("POST /v1/org/webhooks", () => {
  it("maps public event names to QueueEventType and returns the secret once", async () => {
    const registerWebhook = vi.fn((_req, cb) => cb(null, { ...webhook, signingSecret: "whsec_full" }));
    const res = await buildApp({ registerWebhook }).inject({
      method: "POST",
      url: "/v1/org/webhooks",
      payload: { url: "https://example.com/hook", events: ["job.completed", "job.failed", "job.completed"] },
    });

    expect(res.statusCode).toBe(201);
    expect(registerWebhook.mock.calls[0][0]).toMatchObject({
      context: { orgId: "org-1" },
      url: "https://example.com/hook",
      events: [QueueEventType.QUEUE_EVENT_TYPE_COMPLETED, QueueEventType.QUEUE_EVENT_TYPE_FAILED],
    });
    expect(res.json()).toEqual({
      webhookId: "wh-1",
      url: "https://example.com/hook",
      events: ["job.completed", "job.failed"],
      signingSecretHint: "beef",
      active: true,
      signingSecret: "whsec_full",
    });
  });

  it.each([
    [{ url: "not a url", events: ["job.completed"] }],
    [{ url: "https://example.com", events: [] }],
    [{ url: "https://example.com", events: ["job.progress"] }],
  ])("rejects %j without calling jobs-svc", async (payload) => {
    const registerWebhook = vi.fn();
    const res = await buildApp({ registerWebhook }).inject({ method: "POST", url: "/v1/org/webhooks", payload });
    expect(res.statusCode).toBe(400);
    expect(registerWebhook).not.toHaveBeenCalled();
  });

  it("surfaces jobs-svc validation errors (e.g. a private target) as 400", async () => {
    const registerWebhook = vi.fn((_req, cb) => cb(grpcErr(3, "url points at a private or reserved address")));
    const res = await buildApp({ registerWebhook }).inject({
      method: "POST",
      url: "/v1/org/webhooks",
      payload: { url: "http://10.0.0.1/hook", events: ["job.completed"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/private/);
  });
});

describe("GET /v1/org/webhooks", () => {
  it("lists without any secret material beyond the hint", async () => {
    const listWebhooks = vi.fn((_req, cb) => cb(null, { webhooks: [webhook] }));
    const res = await buildApp({ listWebhooks }).inject({ method: "GET", url: "/v1/org/webhooks" });
    expect(res.statusCode).toBe(200);
    expect(res.json().webhooks[0]).toEqual({
      webhookId: "wh-1",
      url: "https://example.com/hook",
      events: ["job.completed", "job.failed"],
      signingSecretHint: "beef",
      active: true,
    });
  });
});

describe("DELETE /v1/org/webhooks/:webhookId", () => {
  it("deletes, and maps NOT_FOUND to 404", async () => {
    const deleteWebhook = vi
      .fn()
      .mockImplementationOnce((_req, cb) => cb(null, { deleted: true }))
      .mockImplementationOnce((_req, cb) => cb(grpcErr(5, "webhook not found")));
    const app = buildApp({ deleteWebhook });

    const ok = await app.inject({ method: "DELETE", url: "/v1/org/webhooks/wh-1" });
    expect(ok.statusCode).toBe(200);
    expect(deleteWebhook.mock.calls[0][0]).toMatchObject({ webhookId: "wh-1", context: { orgId: "org-1" } });

    const missing = await app.inject({ method: "DELETE", url: "/v1/org/webhooks/nope" });
    expect(missing.statusCode).toBe(404);
  });
});
