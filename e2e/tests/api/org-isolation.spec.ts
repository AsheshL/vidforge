import { expect, test } from "@playwright/test";
import { Gateway } from "../../lib/api.js";
import { unique } from "../../lib/env.js";
import { makeTestVideo } from "../../lib/media.js";

// Every read and write is scoped to the caller's org: another org's ids
// must be indistinguishable from ids that don't exist.
test("another org can't see or touch dev-org's assets, jobs or playback", async ({ request }) => {
  const editor = await Gateway.as(request, "editor");
  const outsider = await Gateway.as(request, "otherOwner");
  const { assetId, jobId, storageKey } = await editor.seedCompleted();

  const assets = await (await outsider.get("/v1/assets?pageSize=100")).json();
  expect(assets.assets.map((a: { assetId: string }) => a.assetId)).not.toContain(assetId);
  const jobs = await (await outsider.get("/v1/jobs?pageSize=100")).json();
  expect(jobs.jobs.map((j: { jobId: string }) => j.jobId)).not.toContain(jobId);

  expect((await outsider.get(`/v1/jobs/${jobId}`)).status()).toBe(404);
  expect((await outsider.get(`/v1/jobs/${jobId}/hls/master.m3u8`)).status()).toBe(404);
  expect((await (await outsider.get(`/v1/jobs/${jobId}/thumbnails`)).json()).thumbnails).toEqual([]);
  expect((await outsider.post(`/v1/jobs/${jobId}/cancel`)).status()).toBe(404);
  expect((await outsider.delete(`/v1/jobs/${jobId}`)).status()).toBe(404);

  // Can't transcode someone else's asset either.
  const steal = await outsider.post(`/v1/assets/${assetId}/transcode`, {
    sourceStorageKey: storageKey,
    renditions: [{ name: "240p", width: 426, height: 240, videoBitrateKbps: 400, audioBitrateKbps: 64 }],
  });
  expect(steal.status(), await steal.text()).toBe(404);
  // Nor point a job for an asset of your own at someone else's source.
  const title = unique("e2e-outsider");
  const own = await outsider.upload(makeTestVideo(`${title}.mp4`, { seconds: 2 }), title);
  const borrow = await outsider.post(`/v1/assets/${own.assetId}/transcode`, {
    sourceStorageKey: storageKey,
    renditions: [{ name: "240p", width: 426, height: 240, videoBitrateKbps: 400, audioBitrateKbps: 64 }],
  });
  expect(borrow.status(), await borrow.text()).toBe(400);

  // And the original owner still sees everything intact.
  expect((await editor.get(`/v1/jobs/${jobId}`)).status()).toBe(200);
});
