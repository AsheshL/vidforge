import { expect, test } from "@playwright/test";
import { Gateway, JOB_STATE, RENDITIONS } from "../../lib/api.js";
import { unique } from "../../lib/env.js";
import { makeCorruptVideo } from "../../lib/media.js";
import { signatureValid, startReceiver } from "../../lib/webhook-receiver.js";

const LIFECYCLE = ["job.enqueued", "job.started", "job.completed", "job.failed", "job.retrying"];

test.describe("webhooks", () => {
  test("management is admin-only, org-scoped, and reveals the secret once", async ({ request }) => {
    const admin = await Gateway.as(request, "admin");
    const editor = await Gateway.as(request, "editor");
    const outsider = await Gateway.as(request, "otherOwner");
    const body = { url: "https://example.com/e2e-hook", events: ["job.completed"] };

    expect((await editor.get("/v1/org/webhooks")).status()).toBe(403);
    expect((await editor.post("/v1/org/webhooks", body)).status()).toBe(403);

    const created = await admin.post("/v1/org/webhooks", body);
    expect(created.status(), await created.text()).toBe(201);
    const hook = await created.json();
    expect(hook.signingSecret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(hook.signingSecret.endsWith(hook.signingSecretHint)).toBe(true);
    try {
      const list = await (await admin.get("/v1/org/webhooks")).json();
      const listed = list.webhooks.find((w: { webhookId: string }) => w.webhookId === hook.webhookId);
      expect(listed).toEqual({
        webhookId: hook.webhookId,
        url: body.url,
        events: ["job.completed"],
        signingSecretHint: hook.signingSecretHint,
        active: true,
      });

      expect((await (await outsider.get("/v1/org/webhooks")).json()).webhooks).not.toContainEqual(
        expect.objectContaining({ webhookId: hook.webhookId }),
      );
      expect((await outsider.delete(`/v1/org/webhooks/${hook.webhookId}`)).status()).toBe(404);
    } finally {
      expect((await admin.delete(`/v1/org/webhooks/${hook.webhookId}`)).status()).toBe(200);
    }
    expect((await admin.delete(`/v1/org/webhooks/${hook.webhookId}`)).status()).toBe(404);
  });

  test("registration is validated", async ({ request }) => {
    const admin = await Gateway.as(request, "admin");
    for (const bad of [
      { url: "https://example.com/h", events: ["job.progress"] }, // too chatty for webhooks
      { url: "https://example.com/h", events: [] },
      { url: "not a url", events: ["job.completed"] },
    ]) {
      const res = await admin.post("/v1/org/webhooks", bad);
      expect(res.status(), JSON.stringify(bad)).toBe(400);
    }
  });

  test("private and metadata addresses are refused (SSRF guard)", async ({ request }) => {
    const admin = await Gateway.as(request, "admin");
    const probe = await admin.post("/v1/org/webhooks", { url: "http://127.0.0.1:9/probe", events: ["job.completed"] });
    if (probe.status() === 201) {
      await admin.delete(`/v1/org/webhooks/${(await probe.json()).webhookId}`);
      test.skip(true, "jobs-svc runs with WEBHOOK_ALLOW_PRIVATE_TARGETS=true (local dev); the guard is off by design");
    }
    for (const url of ["http://169.254.169.254/latest/meta-data", "http://10.0.0.1/hook", "http://localhost:8080/hook"]) {
      const res = await admin.post("/v1/org/webhooks", { url, events: ["job.completed"] });
      expect(res.status(), url).toBe(400);
    }
  });

  test.describe("delivery", () => {
    let receiver: Awaited<ReturnType<typeof startReceiver>>;
    let admin: Awaited<ReturnType<typeof Gateway.standalone>>;
    let editor: Awaited<ReturnType<typeof Gateway.standalone>>;
    const hooks: { id: string; secret: string; path: string }[] = [];

    test.beforeAll(async () => {
      receiver = await startReceiver((path, nth) => (path === "/flaky" && nth === 1 ? 500 : path === "/gone" ? 410 : 200));
      admin = await Gateway.standalone("admin");
      editor = await Gateway.standalone("editor");
      // Clean slate so only this suite's hooks receive events.
      for (const w of (await (await admin.get("/v1/org/webhooks")).json()).webhooks) {
        await admin.delete(`/v1/org/webhooks/${w.webhookId}`);
      }
      for (const [path, events] of [
        ["/all", LIFECYCLE],
        ["/completed", ["job.completed"]],
        ["/flaky", ["job.completed"]],
        ["/gone", ["job.completed"]],
      ] as const) {
        const res = await admin.post("/v1/org/webhooks", { url: receiver.url(path), events });
        // Localhost receivers are refused unless jobs-svc allows private targets.
        test.skip(
          res.status() === 400,
          "jobs-svc refuses localhost targets: set WEBHOOK_ALLOW_PRIVATE_TARGETS=true in .env and restart the stack",
        );
        expect(res.status(), await res.text()).toBe(201);
        const hook = await res.json();
        hooks.push({ id: hook.webhookId, secret: hook.signingSecret, path });
      }
    });

    test.afterAll(async () => {
      for (const h of hooks) await admin.delete(`/v1/org/webhooks/${h.id}`);
      await receiver?.close();
      await admin?.dispose();
      await editor?.dispose();
    });

    const secretFor = (path: string) => hooks.find((h) => h.path === path)!.secret;

    test("a successful job delivers signed lifecycle events to each subscriber", async () => {
      const { jobId } = await editor.seedCompleted();
      await expect.poll(() => receiver.forJob(jobId, "/all").map((d) => d.event.type), { timeout: 30_000 }).toEqual([
        "job.enqueued",
        "job.started",
        "job.completed",
      ]);
      await expect.poll(() => receiver.forJob(jobId, "/completed").length, { timeout: 30_000 }).toBe(1);

      for (const d of receiver.forJob(jobId)) {
        expect(signatureValid(secretFor(d.path), d.body, d.headers["vidforge-signature"] as string), d.path).toBe(true);
        expect(d.headers["vidforge-event-id"]).toBe(d.event.id);
        expect(d.headers["vidforge-event-type"]).toBe(d.event.type);
        expect(d.event.data.jobId).toBe(jobId);
      }
      // A wrong secret must not verify.
      const any = receiver.forJob(jobId, "/all")[0];
      expect(signatureValid("whsec_wrong", any.body, any.headers["vidforge-signature"] as string)).toBe(false);
    });

    test("a 5xx is retried until it succeeds; a 410 is not retried", async () => {
      const { jobId } = await editor.seedCompleted();
      // /flaky answers 500 once, then 200: two attempts (~10s backoff).
      await expect.poll(() => receiver.forJob(jobId, "/flaky").length, { timeout: 60_000 }).toBe(2);
      expect(receiver.forJob(jobId, "/gone")).toHaveLength(1);
    });

    test("a failing job delivers retrying events, then failed", async () => {
      const title = unique("e2e-hook-corrupt");
      const { assetId, sourceStorageKey } = await editor.upload(makeCorruptVideo(`${title}.mp4`), title);
      const { jobId } = await editor.transcode(assetId, { sourceStorageKey, renditions: [RENDITIONS.r240] });
      await editor.waitForJob(jobId, [JOB_STATE.FAILED]);
      // Three attempts: enqueued, then started/retrying ×2, started/failed.
      await expect
        .poll(() => receiver.forJob(jobId, "/all").map((d) => d.event.type), { timeout: 30_000 })
        .toEqual([
          "job.enqueued",
          "job.started",
          "job.retrying",
          "job.started",
          "job.retrying",
          "job.started",
          "job.failed",
        ]);
      const failed = receiver.forJob(jobId, "/all").find((d) => d.event.type === "job.failed")!;
      expect(failed.event.data).toMatchObject({ attempt: 3 });
      expect(failed.event.data.detail).not.toBe("");
    });
  });
});

