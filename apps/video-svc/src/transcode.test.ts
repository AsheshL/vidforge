import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CancelToken, renditionOutputOptions, transcodeRendition } from "./transcode.js";

describe("renditionOutputOptions", () => {
  it("forces browser-playable 8-bit 4:2:0 High-profile H.264", () => {
    const opts = renditionOutputOptions("/out", 6);
    expect(opts).toContain("-pix_fmt yuv420p");
    expect(opts).toContain("-profile:v high");
  });

  it("aligns keyframes and HLS segments to the requested duration", () => {
    const opts = renditionOutputOptions("/out", 4);
    expect(opts).toContain("-g 120");
    expect(opts).toContain("-hls_time 4");
    expect(opts).toContain("-hls_segment_filename /out/seg_%04d.ts");
  });
});

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Real encode, run wherever ffmpeg is installed (dev machines, the worker
// image). testsrc renders RGB, which libx264 would otherwise encode as
// High 4:4:4 Predictive — the exact case that produced unplayable output.
describe.skipIf(!hasFfmpeg())("transcodeRendition (real ffmpeg)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vidforge-transcode-test-"));
    execFileSync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "testsrc=duration=2:size=640x360:rate=25",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv444p", "-c:a", "aac", "-shortest", "-y",
      join(dir, "src.mp4"),
    ]);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("turns a 4:4:4 source into 4:2:0 High-profile segments", async () => {
    await transcodeRendition(
      join(dir, "src.mp4"),
      dir,
      { name: "240p", width: 426, height: 240, videoBitrateKbps: 300, audioBitrateKbps: 64 },
      2,
      2,
      () => {},
      new CancelToken(),
    );
    const probe = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=profile,pix_fmt", "-of", "json",
      join(dir, "seg_0000.ts"),
    ]).toString();
    expect(JSON.parse(probe).streams[0]).toEqual({ profile: "High", pix_fmt: "yuv420p" });
  }, 60_000);
});
