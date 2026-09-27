import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ARTIFACTS_DIR = new URL("../.artifacts/", import.meta.url).pathname;
mkdirSync(ARTIFACTS_DIR, { recursive: true });

// A short synthetic clip with audio. pixFmt defaults to yuv444p on purpose:
// it's the chroma format that once made the transcoder emit High 4:4:4
// H.264, which browsers can't decode (see the codec assertions).
export function makeTestVideo(
  name: string,
  { seconds = 6, size = "640x360", pixFmt = "yuv444p" }: { seconds?: number; size?: string; pixFmt?: string } = {},
): string {
  const out = join(ARTIFACTS_DIR, name);
  execFileSync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=${size}:rate=25`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "libx264", "-pix_fmt", pixFmt, "-c:a", "aac", "-shortest", "-y", out,
  ]);
  return out;
}

// An upload that registers fine but isn't a video: every transcode attempt
// fails, so the job retries and then ends FAILED.
export function makeCorruptVideo(name: string): string {
  const out = join(ARTIFACTS_DIR, name);
  writeFileSync(out, Buffer.alloc(64 * 1024, 0x42));
  return out;
}

export interface ProbedStream {
  codec_type: string;
  codec_name: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
}

export function ffprobe(path: string): ProbedStream[] {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,profile,pix_fmt,width,height",
    "-of", "json", path,
  ]).toString();
  return JSON.parse(out).streams;
}

// Decodes every frame; throws if ffmpeg reports any error.
export function assertDecodes(path: string) {
  execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", path, "-f", "null", "-"]);
}
