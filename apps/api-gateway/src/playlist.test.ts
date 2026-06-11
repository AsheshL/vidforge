import { describe, expect, it } from "vitest";
import { rewritePlaylist } from "./playlist.js";

const sign = async (key: string) => `https://store.example/${key}?sig=abc`;

describe("rewritePlaylist", () => {
  it("rewrites segment URIs and keeps comments and variant playlists", async () => {
    const master = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=2628000,RESOLUTION=1280x720",
      "720p/playlist.m3u8",
    ].join("\n");
    expect(await rewritePlaylist(master, "processed/job1/", sign)).toEqual(master);

    const media = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:6",
      "#EXTINF:6.000000,",
      "seg_0000.ts",
      "#EXTINF:4.000000,",
      "seg_0001.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const out = await rewritePlaylist(media, "processed/job1/720p/", sign);
    expect(out).toContain("https://store.example/processed/job1/720p/seg_0000.ts?sig=abc");
    expect(out).toContain("https://store.example/processed/job1/720p/seg_0001.ts?sig=abc");
    expect(out).toContain("#EXT-X-TARGETDURATION:6");
    expect(out).not.toContain("\nseg_0000.ts");
  });

  it("preserves blank lines and line count", async () => {
    const text = "#EXTM3U\n\nseg.ts\n";
    const out = await rewritePlaylist(text, "p/", sign);
    expect(out.split("\n")).toHaveLength(4);
    expect(out.split("\n")[1]).toBe("");
  });
});
