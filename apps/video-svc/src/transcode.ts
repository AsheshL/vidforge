import ffmpeg from "fluent-ffmpeg";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadToFile, uploadDir } from "./storage.js";

export interface Rendition {
  name: string;
  width: number;
  height: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
}

export interface TranscodeProfileJson {
  renditions: Rendition[];
  hlsSegmentSeconds?: number;
  generateThumbnails?: boolean;
  thumbnailIntervalSeconds?: number;
}

export interface TranscodeResult {
  playlistStorageKey: string; // master.m3u8
  renditionKeyPrefixes: Record<string, string>;
  thumbnailStorageKeys: string[];
  sourceDurationSeconds: number;
}

export type ProgressFn = (percent: number, rendition: string, fps: number) => void;

function probeDuration(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(path, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration ?? 0);
    });
  });
}

function transcodeRendition(
  source: string,
  outDir: string,
  r: Rendition,
  segmentSeconds: number,
  durationSeconds: number,
  onProgress: ProgressFn,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(source)
      .videoCodec("libx264")
      .audioCodec("aac")
      .size(`${r.width}x${r.height}`)
      .videoBitrate(r.videoBitrateKbps)
      .audioBitrate(r.audioBitrateKbps)
      .outputOptions([
        "-preset veryfast",
        "-sc_threshold 0",
        `-g ${segmentSeconds * 30}`, // keyframe interval aligned to segments
        "-hls_time " + segmentSeconds,
        "-hls_playlist_type vod",
        `-hls_segment_filename ${join(outDir, "seg_%04d.ts")}`,
      ])
      .output(join(outDir, "playlist.m3u8"))
      .on("progress", (p) => {
        // fluent-ffmpeg's percent is unreliable for HLS; derive from timemark.
        const [h, m, s] = p.timemark.split(":").map(parseFloat);
        const done = h * 3600 + m * 60 + s;
        const percent = durationSeconds > 0 ? Math.min(100, (done / durationSeconds) * 100) : 0;
        onProgress(percent, r.name, p.currentFps ?? 0);
      })
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });
}

function extractThumbnails(
  source: string,
  outDir: string,
  intervalSeconds: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(source)
      .outputOptions([`-vf fps=1/${intervalSeconds},scale=320:-1`, "-q:v 4"])
      .output(join(outDir, "thumb_%04d.jpg"))
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });
}

function masterPlaylist(renditions: Rendition[]): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const r of renditions) {
    const bandwidth = (r.videoBitrateKbps + r.audioBitrateKbps) * 1000;
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${r.width}x${r.height}`,
      `${r.name}/playlist.m3u8`,
    );
  }
  return lines.join("\n") + "\n";
}

export async function runTranscode(
  jobId: string,
  sourceStorageKey: string,
  profile: TranscodeProfileJson,
  onProgress: ProgressFn,
): Promise<TranscodeResult> {
  const work = join(tmpdir(), `vidforge-${jobId}`);
  const sourcePath = join(work, "source");
  const outRoot = join(work, "out");
  const segmentSeconds = profile.hlsSegmentSeconds ?? 6;

  try {
    await mkdir(outRoot, { recursive: true });
    await downloadToFile(sourceStorageKey, sourcePath);
    const duration = await probeDuration(sourcePath);

    const total = profile.renditions.length;
    for (let i = 0; i < total; i++) {
      const r = profile.renditions[i];
      const dir = join(outRoot, r.name);
      await mkdir(dir, { recursive: true });
      await transcodeRendition(sourcePath, dir, r, segmentSeconds, duration, (pct, name, fps) =>
        // Scale per-rendition progress into overall job progress.
        onProgress((i / total) * 100 + pct / total, name, fps),
      );
    }

    if (profile.generateThumbnails) {
      const dir = join(outRoot, "thumbs");
      await mkdir(dir, { recursive: true });
      await extractThumbnails(sourcePath, dir, profile.thumbnailIntervalSeconds ?? 10);
    }

    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(outRoot, "master.m3u8"), masterPlaylist(profile.renditions));

    const keyPrefix = `processed/${jobId}`;
    const keys = await uploadDir(outRoot, keyPrefix);

    return {
      playlistStorageKey: `${keyPrefix}/master.m3u8`,
      renditionKeyPrefixes: Object.fromEntries(
        profile.renditions.map((r) => [r.name, `${keyPrefix}/${r.name}`]),
      ),
      thumbnailStorageKeys: keys.filter((k) => k.includes("/thumbs/")),
      sourceDurationSeconds: duration,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
