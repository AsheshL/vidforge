import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { Gateway, JOB_STATE, playlistUris, RENDITIONS } from "../../lib/api.js";
import { GATEWAY_URL, unique } from "../../lib/env.js";
import { ARTIFACTS_DIR, assertDecodes, ffprobe, makeTestVideo } from "../../lib/media.js";

// One upload → transcode → playback pipeline, checked stage by stage.
test.describe.serial("transcode and playback pipeline", () => {
  let editor: Awaited<ReturnType<typeof Gateway.standalone>>;
  let viewer: Awaited<ReturnType<typeof Gateway.standalone>>;
  let assetId: string;
  let sourceStorageKey: string;
  let jobId: string;
  const title = unique("e2e-pipeline");

  test.beforeAll(async () => {
    editor = await Gateway.standalone("editor");
    viewer = await Gateway.standalone("viewer");
    // 4:4:4 source on purpose: the transcoder must still emit 4:2:0.
    const file = makeTestVideo(`${title}.mp4`, { seconds: 8, size: "1280x720", pixFmt: "yuv444p" });
    ({ assetId, sourceStorageKey } = await editor.upload(file, title));
  });
  test.afterAll(async () => {
    await editor?.dispose();
    await viewer?.dispose();
  });

  test("viewers cannot submit a transcode", async () => {
    const res = await viewer.post(`/v1/assets/${assetId}/transcode`, {
      sourceStorageKey,
      renditions: [RENDITIONS.r360],
    });
    expect(res.status()).toBe(403);
  });

  test("transcode request is validated", async () => {
    expect((await editor.post(`/v1/assets/${assetId}/transcode`, {})).status()).toBe(400);
    const tooShort = await editor.post(`/v1/assets/${assetId}/transcode`, {
      sourceStorageKey,
      renditions: [RENDITIONS.r360],
      hlsSegmentSeconds: 1,
    });
    expect(tooShort.status()).toBe(400);
  });

  test("editor submits a two-rendition job and follows it live over SSE", async () => {
    const submitted = await editor.transcode(assetId, {
      sourceStorageKey,
      renditions: [RENDITIONS.r360, RENDITIONS.r240],
      hlsSegmentSeconds: 4,
      generateThumbnails: true,
    });
    jobId = submitted.jobId;
    expect(submitted.state).toBe(JOB_STATE.QUEUED);

    // The SSE feed must emit data events while the job runs. Read a short
    // window of the stream (the endpoint keeps the connection open).
    const events: string[] = [];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6_000);
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/jobs/${jobId}/events?access_token=${editor.token}`, {
        signal: ctrl.signal,
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        events.push(...decoder.decode(value).split("\n").filter((l) => l.startsWith("data:")));
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") throw err;
    } finally {
      clearTimeout(timer);
    }
    expect(events.length, "SSE progress events").toBeGreaterThan(0);

    const done = await editor.waitForJob(jobId);
    expect(done.progressPercent).toBe(100);
    expect(done.errorMessage).toBe("");
  });

  test("asset is READY with a probed duration", async () => {
    const list = await (await editor.get("/v1/assets?pageSize=100")).json();
    const asset = list.assets.find((a: { assetId: string }) => a.assetId === assetId);
    expect(asset).toMatchObject({ status: "READY", latestCompletedJobId: jobId });
    expect(Math.round(asset.durationSeconds)).toBe(8);
  });

  test("viewer plays HLS: master → variants → presigned segments", async ({ request }) => {
    const master = await viewer.get(`/v1/jobs/${jobId}/hls/master.m3u8`);
    expect(master.status()).toBe(200);
    expect(master.headers()["content-type"]).toContain("mpegurl");
    const variants = playlistUris(await master.text());
    expect(variants.sort()).toEqual(["240p/playlist.m3u8", "360p/playlist.m3u8"]);

    for (const variant of variants) {
      const playlist = await viewer.get(`/v1/jobs/${jobId}/hls/${variant}`);
      expect(playlist.status()).toBe(200);
      const segments = playlistUris(await playlist.text());
      expect(segments.length).toBeGreaterThanOrEqual(2); // 8s at 4s segments
      // Segment URIs are presigned object-storage URLs — fetched directly,
      // without the gateway or a bearer token.
      for (const seg of segments) expect(seg).toMatch(/^https?:\/\/.*X-Amz-Signature=/);
      const segRes = await request.get(segments[0]);
      expect(segRes.status()).toBe(200);
      const path = join(ARTIFACTS_DIR, `${title}-${variant.split("/")[0]}.ts`);
      await writeFile(path, await segRes.body());

      // Browser-playable output: 8-bit 4:2:0 H.264 High (not High 4:4:4 /
      // High 10) plus AAC, at the requested size, and it decodes cleanly.
      const streams = ffprobe(path);
      const video = streams.find((s) => s.codec_type === "video")!;
      const audio = streams.find((s) => s.codec_type === "audio")!;
      const want = variant.startsWith("360p") ? RENDITIONS.r360 : RENDITIONS.r240;
      expect(video).toMatchObject({ codec_name: "h264", profile: "High", pix_fmt: "yuv420p", width: want.width, height: want.height });
      expect(audio).toMatchObject({ codec_name: "aac" });
      assertDecodes(path);
    }
  });

  test("playback route only serves playlists and rejects path tricks", async () => {
    expect((await viewer.get(`/v1/jobs/${jobId}/hls/360p/seg_0000.ts`)).status()).toBe(404);
    expect((await viewer.get(`/v1/jobs/${jobId}/hls/..%2F..%2Fsecret.m3u8`)).status()).toBe(400);
    expect((await viewer.get(`/v1/jobs/does-not-exist/hls/master.m3u8`)).status()).toBe(404);
  });

  test("thumbnails are presigned JPEGs", async ({ request }) => {
    const res = await viewer.get(`/v1/jobs/${jobId}/thumbnails`);
    expect(res.status()).toBe(200);
    const { thumbnails } = await res.json();
    expect(thumbnails.length).toBeGreaterThan(0);
    const img = await request.get(thumbnails[0]);
    expect(img.status()).toBe(200);
    const bytes = await img.body();
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff])); // JPEG magic
  });
});
