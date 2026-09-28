import { describe, expect, it, vi } from "vitest";

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: vi.fn().mockResolvedValue({ Body: [] }) })),
  GetObjectCommand: vi.fn(),
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://signed.example/x"),
}));
vi.mock("../playlist.js", () => ({ rewritePlaylist: vi.fn().mockResolvedValue("#EXTM3U rewritten") }));

import { fetchHlsPlaylist, fetchThumbnailUrls } from "./playback.js";

const ctx = { userId: "u1", orgId: "org1", roles: ["VIEWER"], traceId: "t1", issuedAtMs: 0, signature: "" } as never;

describe("fetchHlsPlaylist", () => {
  it("rejects non-m3u8 paths", async () => {
    const result = await fetchHlsPlaylist({} as never, ctx, "job1", "segment.ts");
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("rejects path traversal", async () => {
    const result = await fetchHlsPlaylist({} as never, ctx, "job1", "../../etc/passwd.m3u8");
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("404s when the job has no output manifest", async () => {
    const videoClient = { getOutputManifest: vi.fn((_req, cb) => cb(new Error("not found"), undefined)) };
    const result = await fetchHlsPlaylist(videoClient as never, ctx, "job1", "master.m3u8");
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("returns the rewritten playlist on success", async () => {
    const videoClient = {
      getOutputManifest: vi.fn((_req, cb) => cb(null, { playlistStorageKey: "jobs/job1/master.m3u8" })),
    };
    const result = await fetchHlsPlaylist(videoClient as never, ctx, "job1", "master.m3u8");
    expect(result).toMatchObject({ ok: true, body: "#EXTM3U rewritten" });
  });
});

describe("fetchThumbnailUrls", () => {
  it("returns an empty array when there's no manifest", async () => {
    const videoClient = { getOutputManifest: vi.fn((_req, cb) => cb(new Error("nope"), undefined)) };
    await expect(fetchThumbnailUrls(videoClient as never, ctx, "job1")).resolves.toEqual([]);
  });

  it("presigns every thumbnail key", async () => {
    const videoClient = {
      getOutputManifest: vi.fn((_req, cb) => cb(null, { thumbnailStorageKeys: ["a.jpg", "b.jpg"] })),
    };
    await expect(fetchThumbnailUrls(videoClient as never, ctx, "job1")).resolves.toEqual([
      "https://signed.example/x",
      "https://signed.example/x",
    ]);
  });
});
