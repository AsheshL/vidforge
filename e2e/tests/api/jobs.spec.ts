import { expect, test } from "@playwright/test";
import { Gateway, JOB_STATE, RENDITIONS } from "../../lib/api.js";
import { unique } from "../../lib/env.js";
import { makeCorruptVideo, makeTestVideo } from "../../lib/media.js";

test.describe("job lifecycle", () => {
  test("re-run a completed asset with a different profile", async ({ request }) => {
    const editor = await Gateway.as(request, "editor");
    const { assetId, jobId, storageKey } = await editor.seedCompleted();
    const rerun = await editor.transcode(assetId, { sourceStorageKey: storageKey, renditions: [RENDITIONS.r240] });
    expect(rerun.jobId).not.toBe(jobId);
    await editor.waitForJob(rerun.jobId);
    const master = await (await editor.get(`/v1/jobs/${rerun.jobId}/hls/master.m3u8`)).text();
    expect(master).toContain("240p/playlist.m3u8");
    expect(master).not.toContain("720p");
  });

  test("idempotency key returns the original job", async ({ request }) => {
    const editor = await Gateway.as(request, "editor");
    const title = unique("e2e-idem");
    const { assetId, sourceStorageKey } = await editor.upload(makeTestVideo(`${title}.mp4`, { seconds: 2 }), title);
    const body = { sourceStorageKey, renditions: [RENDITIONS.r240], idempotencyKey: title };
    const first = await editor.transcode(assetId, body);
    const second = await editor.transcode(assetId, body);
    expect(second.jobId).toBe(first.jobId);
    await editor.waitForJob(first.jobId);
  });

  test("cancel an in-flight job, then delete it", async ({ request }) => {
    const editor = await Gateway.as(request, "editor");
    const title = unique("e2e-cancel");
    // Long enough at 720p that it is still queued or processing when cancelled.
    const file = makeTestVideo(`${title}.mp4`, { seconds: 40, size: "1280x720", pixFmt: "yuv420p" });
    const { assetId, sourceStorageKey } = await editor.upload(file, title);
    const { jobId } = await editor.transcode(assetId, {
      sourceStorageKey,
      renditions: [{ name: "720p", width: 1280, height: 720, videoBitrateKbps: 2500, audioBitrateKbps: 128 }],
    });

    const cancel = await editor.post(`/v1/jobs/${jobId}/cancel`);
    expect(cancel.status(), await cancel.text()).toBe(200);
    await expect.poll(async () => (await editor.job(jobId)).state).toBe(JOB_STATE.CANCELLED);

    expect((await editor.delete(`/v1/jobs/${jobId}`)).status()).toBe(200);
    expect((await editor.get(`/v1/jobs/${jobId}`)).status()).toBe(404);
  });

  test("an unreadable source retries, then fails with an error", async ({ request }) => {
    const editor = await Gateway.as(request, "editor");
    const title = unique("e2e-corrupt");
    const { assetId, sourceStorageKey } = await editor.upload(makeCorruptVideo(`${title}.mp4`), title);
    const { jobId } = await editor.transcode(assetId, { sourceStorageKey, renditions: [RENDITIONS.r240] });
    const failed = await editor.waitForJob(jobId, [JOB_STATE.FAILED]);
    expect(failed.errorMessage).not.toBe("");
  });

  test("viewers cannot cancel or delete jobs", async ({ request }) => {
    const editor = await Gateway.as(request, "editor");
    const viewer = await Gateway.as(request, "viewer");
    const { jobId } = await editor.seedCompleted();
    expect((await viewer.post(`/v1/jobs/${jobId}/cancel`)).status()).toBe(403);
    expect((await viewer.delete(`/v1/jobs/${jobId}`)).status()).toBe(403);
    // …but can read it.
    expect((await viewer.get(`/v1/jobs/${jobId}`)).status()).toBe(200);
  });
});

test.describe("listing and pagination", () => {
  test.beforeAll(async ({ request }) => {
    // Pagination needs at least three of each.
    const editor = await Gateway.as(request, "editor");
    const { assets } = await (await editor.get("/v1/assets?pageSize=3")).json();
    for (let i = assets.length; i < 3; i++) await editor.seed();
  });

  for (const kind of ["assets", "jobs"] as const) {
    test(`${kind}: cursor pages are disjoint and totalCount is stable`, async ({ request }) => {
      const viewer = await Gateway.as(request, "viewer");
      const idKey = kind === "assets" ? "assetId" : "jobId";
      const page1 = await (await viewer.get(`/v1/${kind}?pageSize=2`)).json();
      expect(page1[kind]).toHaveLength(2);
      expect(page1.pageInfo.totalCount).toBeGreaterThanOrEqual(3);
      expect(page1.pageInfo.nextPageToken).toBeTruthy();

      const page2 = await (
        await viewer.get(`/v1/${kind}?pageSize=2&pageToken=${encodeURIComponent(page1.pageInfo.nextPageToken)}`)
      ).json();
      expect(page2[kind].length).toBeGreaterThanOrEqual(1);
      const ids1 = page1[kind].map((x: Record<string, string>) => x[idKey]);
      const ids2 = page2[kind].map((x: Record<string, string>) => x[idKey]);
      expect(ids1.filter((id: string) => ids2.includes(id))).toEqual([]);
      expect(page2.pageInfo.totalCount).toBe(page1.pageInfo.totalCount);
    });

    test(`${kind}: pageSize defaults to 50 and is clamped to [1, 100]`, async ({ request }) => {
      const viewer = await Gateway.as(request, "viewer");
      const count = async (q: string) => (await (await viewer.get(`/v1/${kind}${q}`)).json())[kind].length;
      const total = (await (await viewer.get(`/v1/${kind}?pageSize=1`)).json()).pageInfo.totalCount;
      expect(await count("")).toBe(Math.min(total, 50));
      expect(await count("?pageSize=0")).toBe(Math.min(total, 50)); // 0 = unset
      expect(await count("?pageSize=-5")).toBe(1);
      expect(await count("?pageSize=1000")).toBe(Math.min(total, 100));
    });
  }
});
