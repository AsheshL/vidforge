import { UnrecoverableError } from "bullmq";
import { prisma } from "@vidforge/db";
import {
  createRedis,
  createTranscodeWorker,
  createWebhookQueue,
  TRANSCODE_CANCEL_CHANNEL,
  type TranscodeJobData,
} from "@vidforge/queue";
import { createWebhookPublisher } from "@vidforge/webhooks";
import { ensureBucket } from "./storage.js";
import { CancelledError, CancelToken, runTranscode, type TranscodeProfileJson } from "./transcode.js";

export function startWorker() {
  // One token per active job; the cancel pub/sub message kills its ffmpeg.
  const activeTokens = new Map<string, CancelToken>();

  const publishWebhook = createWebhookPublisher(createWebhookQueue());

  const subscriber = createRedis();
  void subscriber.subscribe(TRANSCODE_CANCEL_CHANNEL);
  subscriber.on("message", (channel, jobId) => {
    if (channel !== TRANSCODE_CANCEL_CHANNEL) return;
    const token = activeTokens.get(jobId);
    if (token) {
      console.log(`killing in-flight transcode for cancelled job ${jobId}`);
      token.cancel();
    }
  });

  const worker = createTranscodeWorker(async (job) => {
    const { jobId, orgId, assetId, sourceStorageKey, profileJson } = job.data as TranscodeJobData;
    // attemptsMade counts finished attempts, so this one is attemptsMade + 1.
    const attempt = job.attemptsMade + 1;

    // Guarded transition: a job cancelled between enqueue and pickup is
    // already CANCELLED and must not flip back to PROCESSING.
    const started = await prisma.transcodeJob.updateMany({
      where: { id: jobId, state: { in: ["QUEUED", "PROCESSING"] } },
      data: { state: "PROCESSING", startedAt: new Date() },
    });
    if (started.count === 0) {
      throw new UnrecoverableError(`job ${jobId} was cancelled before processing started`);
    }
    void publishWebhook({ type: "QUEUE_EVENT_TYPE_STARTED", orgId, jobId, assetId, attempt });

    const token = new CancelToken();
    activeTokens.set(jobId, token);

    let result;
    try {
      let lastPersisted = 0;
      result = await runTranscode(
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
        token,
      );
    } catch (err) {
      if (err instanceof CancelledError || token.cancelled) {
        // The row is already CANCELLED (cancelJob set it); just stop
        // without retrying.
        throw new UnrecoverableError(`job ${jobId} cancelled mid-transcode`);
      }
      throw err;
    } finally {
      activeTokens.delete(jobId);
    }

    // updateMany so a job cancelled in the last instant stays CANCELLED
    // instead of being overwritten when the in-flight transcode finishes.
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
    void publishWebhook({ type: "QUEUE_EVENT_TYPE_COMPLETED", orgId, jobId, assetId, attempt });

    // A thumbnails-only job (GenerateThumbnails RPC) has no renditions and
    // so no playlist; the asset's playback state is untouched.
    if (result.playlistStorageKey) {
      await prisma.asset.update({
        where: { id: job.data.assetId },
        data: {
          status: "READY",
          playbackUrl: `s3://${process.env.S3_BUCKET ?? "vidforge-media"}/${result.playlistStorageKey}`,
          durationSeconds: result.sourceDurationSeconds,
        },
      });
    }

    return result;
  });

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const { jobId, orgId, assetId } = job.data;
    // Cancellations already wrote their terminal state; don't mark FAILED.
    if (err instanceof UnrecoverableError && err.message.includes("cancelled")) {
      console.log(`transcode job ${jobId} stopped: ${err.message}`);
      return;
    }
    console.error(`transcode job ${jobId} failed:`, err.message);
    // By now attemptsMade includes the attempt that just failed.
    const attempt = job.attemptsMade;
    // Only mark FAILED once retries are exhausted.
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await prisma.transcodeJob.update({
        where: { id: jobId },
        data: { state: "FAILED", errorMessage: err.message, finishedAt: new Date() },
      });
      void publishWebhook({ type: "QUEUE_EVENT_TYPE_FAILED", orgId, jobId, assetId, attempt, detail: err.message });
    } else {
      void publishWebhook({ type: "QUEUE_EVENT_TYPE_RETRYING", orgId, jobId, assetId, attempt, detail: err.message });
    }
  });

  void ensureBucket();
  console.log("transcode worker started");
  return worker;
}
