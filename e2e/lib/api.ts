import { readFile, stat } from "node:fs/promises";
import { expect, request as playwrightRequest, type APIRequestContext, type APIResponse } from "@playwright/test";
import { ACCOUNTS, GATEWAY_URL, type AccountName } from "./env.js";

export const JOB_STATE = { QUEUED: 1, PROCESSING: 2, COMPLETED: 3, FAILED: 4, CANCELLED: 5 } as const;

export interface Session {
  token: string;
  user: { userId: string; email: string; displayName: string; orgId: string; role: number };
}

export async function devLogin(request: APIRequestContext, who: AccountName): Promise<Session> {
  const res = await request.post(`${GATEWAY_URL}/v1/dev/login`, { data: { email: ACCOUNTS[who].email } });
  expect(res.status(), `dev login for ${who}`).toBe(200);
  return res.json();
}

// Thin authenticated wrapper over Playwright's request context. Every call
// resolves to the raw APIResponse so tests assert on status themselves.
export class Gateway {
  constructor(
    private readonly request: APIRequestContext,
    readonly token: string,
  ) {}

  static async as(request: APIRequestContext, who: AccountName) {
    const session = await devLogin(request, who);
    return Object.assign(new Gateway(request, session.token), { session });
  }

  // For beforeAll/afterAll: Playwright forbids reusing the per-test
  // `request` fixture across tests, so hooks get a context of their own.
  static async standalone(who: AccountName) {
    const ctx = await playwrightRequest.newContext();
    const g = await Gateway.as(ctx, who);
    return Object.assign(g, { dispose: () => ctx.dispose() });
  }

  private headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }
  get(path: string): Promise<APIResponse> {
    return this.request.get(`${GATEWAY_URL}${path}`, { headers: this.headers() });
  }
  post(path: string, data?: unknown): Promise<APIResponse> {
    return this.request.post(`${GATEWAY_URL}${path}`, { headers: this.headers(), data });
  }
  delete(path: string): Promise<APIResponse> {
    return this.request.delete(`${GATEWAY_URL}${path}`, { headers: this.headers() });
  }

  // tus 1.0 upload in a single PATCH, then claims it as an asset.
  async upload(filePath: string, title: string) {
    const size = (await stat(filePath)).size;
    const create = await this.request.post(`${GATEWAY_URL}/v1/uploads`, {
      headers: this.headers({
        "tus-resumable": "1.0.0",
        "upload-length": String(size),
        "upload-metadata": `filename ${Buffer.from(title).toString("base64")}`,
      }),
    });
    expect(create.status(), "tus create").toBe(201);
    const location = create.headers()["location"];
    const uploadUrl = location.startsWith("http") ? location : `${GATEWAY_URL}${location}`;
    const patch = await this.request.patch(uploadUrl, {
      headers: this.headers({
        "tus-resumable": "1.0.0",
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
      }),
      data: await readFile(filePath),
    });
    expect(patch.status(), "tus patch").toBe(204);
    const uploadKey = uploadUrl.split("/").pop()!;
    const reg = await this.post("/v1/assets/register", { uploadKey, title });
    expect(reg.status(), "register asset").toBe(201);
    return { uploadKey, ...(await reg.json()) } as { uploadKey: string; assetId: string; sourceStorageKey: string };
  }

  async transcode(assetId: string, body: Record<string, unknown>) {
    const res = await this.post(`/v1/assets/${assetId}/transcode`, body);
    expect(res.status(), `transcode submit: ${await res.text()}`).toBe(202);
    return (await res.json()) as { jobId: string; state: number };
  }

  async job(jobId: string) {
    const res = await this.get(`/v1/jobs/${jobId}`);
    expect(res.status()).toBe(200);
    return res.json() as Promise<{ jobId: string; assetId: string; state: number; errorMessage: string; progressPercent: number }>;
  }

  async waitForJob(jobId: string, states: number[] = [JOB_STATE.COMPLETED], timeoutMs = 120_000) {
    let last = 0;
    await expect
      .poll(async () => (last = (await this.job(jobId)).state), { timeout: timeoutMs, intervals: [1000] })
      .toBeGreaterThanOrEqual(JOB_STATE.COMPLETED);
    expect(states, `job ${jobId} ended in state ${last}`).toContain(last);
    return this.job(jobId);
  }

  // Dev-only one-shot: generated clip + asset + 720p/360p transcode job.
  async seed() {
    const res = await this.post("/v1/dev/seed");
    expect(res.status(), "dev seed").toBe(201);
    return (await res.json()) as { assetId: string; jobId: string; storageKey: string };
  }

  async seedCompleted() {
    const seeded = await this.seed();
    await this.waitForJob(seeded.jobId);
    return seeded;
  }
}

export const RENDITIONS = {
  r360: { name: "360p", width: 640, height: 360, videoBitrateKbps: 800, audioBitrateKbps: 96 },
  r240: { name: "240p", width: 426, height: 240, videoBitrateKbps: 400, audioBitrateKbps: 64 },
};

// Non-comment lines of an m3u8 playlist: variant or segment URIs.
export const playlistUris = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
