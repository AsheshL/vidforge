import http from "node:http";
import type { AddressInfo } from "node:net";
import { UnrecoverableError } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@vidforge/db", () => ({ prisma: {} }));

import type { WebhookEvent, WebhookJobData } from "@vidforge/queue";
import { createWebhookProcessor, isRetryableStatus, webhookPayload } from "./deliver.js";
import { createWebhookPublisher } from "./publish.js";
import { signWebhookPayload, verifyWebhookSignature } from "./signature.js";
import { guardedLookup, isBlockedAddress, targetPolicyFromEnv, validateWebhookUrl, WebhookTargetError } from "./target.js";

const STRICT = { allowPrivate: false, requireHttps: false };
const LOCAL = { allowPrivate: true, requireHttps: false };

describe("signature", () => {
  it("verifies its own signature and rejects a tampered body or wrong secret", () => {
    const header = signWebhookPayload("whsec_1", '{"a":1}', 1_000);
    expect(verifyWebhookSignature("whsec_1", '{"a":1}', header, { now: 1_000 })).toBe(true);
    expect(verifyWebhookSignature("whsec_1", '{"a":2}', header, { now: 1_000 })).toBe(false);
    expect(verifyWebhookSignature("whsec_2", '{"a":1}', header, { now: 1_000 })).toBe(false);
  });

  it("rejects a timestamp outside the tolerance window (replay)", () => {
    const header = signWebhookPayload("whsec_1", "{}", 1_000);
    expect(verifyWebhookSignature("whsec_1", "{}", header, { now: 1_000 + 301 })).toBe(false);
  });

  it("rejects a malformed header", () => {
    expect(verifyWebhookSignature("whsec_1", "{}", "garbage")).toBe(false);
    expect(verifyWebhookSignature("whsec_1", "{}", "t=1,v1=zz")).toBe(false);
  });
});

describe("target guard", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(["93.184.216.34", "2606:2800:220:1::1"])("allows public %s", (ip) =>
    expect(isBlockedAddress(ip)).toBe(false),
  );

  it("rejects non-http schemes, embedded credentials, internal names and private literals", () => {
    for (const url of [
      "ftp://example.com/x",
      "https://user:pw@example.com/x",
      "http://localhost:3000/x",
      "http://metadata.google.internal/x",
      "http://[::1]/x",
      "http://169.254.169.254/latest",
      "not a url",
    ]) {
      expect(() => validateWebhookUrl(url, STRICT), url).toThrow(WebhookTargetError);
    }
    expect(validateWebhookUrl("https://example.com/hook", STRICT).hostname).toBe("example.com");
  });

  it("requires https in production and never allows private targets there", () => {
    const prod = targetPolicyFromEnv({ NODE_ENV: "production", WEBHOOK_ALLOW_PRIVATE_TARGETS: "true" });
    expect(prod).toEqual({ allowPrivate: false, requireHttps: true });
    expect(() => validateWebhookUrl("http://example.com/hook", prod)).toThrow(/https/);
    expect(targetPolicyFromEnv({ WEBHOOK_ALLOW_PRIVATE_TARGETS: "true" }).allowPrivate).toBe(true);
  });

  it("refuses a hostname that resolves to a private address at connect time", async () => {
    const err = await new Promise<Error | null>((resolve) =>
      guardedLookup(STRICT)("localhost", {}, (e) => resolve(e)),
    );
    expect(err).toBeInstanceOf(WebhookTargetError);
  });
});

describe("publish", () => {
  const input = {
    type: "QUEUE_EVENT_TYPE_COMPLETED" as const,
    orgId: "org-1",
    jobId: "job-1",
    assetId: "asset-1",
    attempt: 2,
  };

  it("enqueues one delivery per subscribed webhook with a dedupe-safe job id", async () => {
    const addBulk = vi.fn().mockResolvedValue([]);
    const find = vi.fn().mockResolvedValue([{ id: "wh1" }, { id: "wh2" }]);
    await createWebhookPublisher({ addBulk } as never, find)(input);

    expect(find).toHaveBeenCalledWith("org-1", "QUEUE_EVENT_TYPE_COMPLETED");
    const jobs = addBulk.mock.calls[0][0];
    expect(jobs.map((j: { opts: { jobId: string } }) => j.opts.jobId)).toEqual([
      "wh1-evt_job-1_completed_2",
      "wh2-evt_job-1_completed_2",
    ]);
    for (const j of jobs) expect(j.opts.jobId).not.toContain(":");
    expect(jobs[0].data).toMatchObject({ webhookId: "wh1", event: { id: "evt_job-1_completed_2", ...input } });
  });

  it("skips the queue when nothing is subscribed", async () => {
    const addBulk = vi.fn();
    await createWebhookPublisher({ addBulk } as never, vi.fn().mockResolvedValue([]))(input);
    expect(addBulk).not.toHaveBeenCalled();
  });

  it("never throws into the caller", async () => {
    const find = vi.fn().mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(createWebhookPublisher({ addBulk: vi.fn() } as never, find)(input)).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe("deliver", () => {
  const event: WebhookEvent = {
    id: "evt_job-1_completed_1",
    type: "QUEUE_EVENT_TYPE_COMPLETED",
    orgId: "org-1",
    jobId: "job-1",
    assetId: "asset-1",
    attempt: 1,
    detail: "",
    occurredAt: "2026-09-27T00:00:00.000Z",
  };
  const job = (webhookId = "wh1") => ({ data: { webhookId, event } as WebhookJobData }) as never;

  let server: http.Server;
  let baseUrl: string;
  let nextStatus = 200;
  let received: { headers: http.IncomingHttpHeaders; body: string }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        if (req.url === "/slow") return; // never answers
        res.writeHead(nextStatus).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  beforeEach(() => {
    received = [];
    nextStatus = 200;
  });

  const hook = (path = "/hook", extra = {}) => ({
    id: "wh1",
    url: `${baseUrl}${path}`,
    signingSecret: "whsec_test",
    active: true,
    ...extra,
  });

  it("posts the signed payload with event headers", async () => {
    const process = createWebhookProcessor({ policy: LOCAL, find: async () => hook() });
    await expect(process(job())).resolves.toEqual({ status: 200 });

    const [{ headers, body }] = received;
    expect(JSON.parse(body)).toEqual(webhookPayload(event));
    expect(JSON.parse(body).type).toBe("job.completed");
    expect(headers["vidforge-event-id"]).toBe(event.id);
    expect(headers["vidforge-event-type"]).toBe("job.completed");
    expect(verifyWebhookSignature("whsec_test", body, headers["vidforge-signature"] as string)).toBe(true);
  });

  it("retries a 5xx/429 but gives up on other 4xx", async () => {
    const process = createWebhookProcessor({ policy: LOCAL, find: async () => hook() });
    nextStatus = 503;
    const retryable = await process(job()).catch((e) => e);
    expect(retryable).toBeInstanceOf(Error);
    expect(retryable).not.toBeInstanceOf(UnrecoverableError);

    nextStatus = 404;
    await expect(process(job())).rejects.toBeInstanceOf(UnrecoverableError);

    expect([408, 429, 500, 502].every(isRetryableStatus)).toBe(true);
    expect([301, 400, 401, 404, 410].some(isRetryableStatus)).toBe(false);
  });

  it("times out (retryably) on a receiver that never answers", async () => {
    const process = createWebhookProcessor({ policy: LOCAL, timeoutMs: 200, find: async () => hook("/slow") });
    const err = await process(job()).catch((e) => e);
    expect(err.message).toMatch(/timed out/);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it("drops the delivery when the webhook was deleted or deactivated", async () => {
    await expect(createWebhookProcessor({ policy: LOCAL, find: async () => null })(job())).resolves.toEqual({
      skipped: true,
    });
    await expect(
      createWebhookProcessor({ policy: LOCAL, find: async () => hook("/hook", { active: false }) })(job()),
    ).resolves.toEqual({ skipped: true });
    expect(received).toHaveLength(0);
  });

  it("refuses a private target without sending anything", async () => {
    const process = createWebhookProcessor({ policy: STRICT, find: async () => hook() });
    await expect(process(job())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(received).toHaveLength(0);
  });
});
