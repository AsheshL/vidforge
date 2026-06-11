import { prisma } from "@vidforge/db";
import { createTranscodeWorker, type TranscodeJobData } from "@vidforge/queue";
import { ensureBucket } from "./storage.js";
import { runTranscode, type TranscodeProfileJson } from "./transcode.js";

export function startWorker() {
  const worker = createTranscodeWorker(async (job) => {
    const { jobId, sourceStorageKey, profileJson } = job.data as TranscodeJobData;

    await prisma.transcodeJob.update({
      where: { id: jobId },
      data: { state: "PROCESSING", startedAt: new Date() },
    });

    let lastPersisted = 0;
    const result = await runTranscode(
      jobId,
      sourceStorageKey,
      profileJson as TranscodeProfileJson,
      (percent, rendition, fps) => {
        void job.updateProgress({ percent, rendition, fps });
        // Throttle DB writes to every 5%.
        if (percent - lastPersisted >= 5) {
          lastPersisted = percent;
          void prisma.transcodeJob.update({
            where: { id: jobId },
            data: { progressPercent: percent },
          });
        }
      },
    );

    // updateMany so a job cancelled mid-run stays CANCELLED instead of
    // being overwritten when the in-flight transcode finishes.
    const completed = await prisma.transcodeJob.updateMany({
      where: { id: jobId, state: "PROCESSING" },
      data: {
        state: "COMPLETED",
        progressPercent: 100,
        finishedAt: new Date(),
        manifestJson: result as object,
      },
    });
    if (completed.count === 0) return result;

    await prisma.asset.update({
      where: { id: job.data.assetId },
      data: {
        status: "READY",
        playbackUrl: `s3://${process.env.S3_BUCKET ?? "vidforge-media"}/${result.playlistStorageKey}`,
        durationSeconds: result.sourceDurationSeconds,
      },
    });

    return result;
  });

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const { jobId } = job.data;
    console.error(`transcode job ${jobId} failed:`, err.message);
    // Only mark FAILED once retries are exhausted.
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await prisma.transcodeJob.update({
        where: { id: jobId },
        data: { state: "FAILED", errorMessage: err.message, finishedAt: new Date() },
      });
    }
  });

  void ensureBucket();
  console.log("transcode worker started");
  return worker;
}
