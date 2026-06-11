import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { FastifyInstance } from "fastify";
import { prisma } from "@vidforge/db";
import type { VideoServiceClient } from "@vidforge/proto/video";
import { authClient, requireRole } from "../auth.js";

const BUCKET = process.env.S3_BUCKET ?? "vidforge-media";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "vidforge",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "vidforge-secret",
  },
});

const SEED_VIDEO = join(tmpdir(), "vidforge-seed.mp4");

const execFileAsync = promisify(execFile);

// Renders a 10s test pattern once, then reuses it for subsequent seeds.
// Raw ffmpeg invocation: fluent-ffmpeg rejects lavfi inputs because its
// capability probe only lists demuxers.
async function ensureSeedVideo(): Promise<string> {
  if (existsSync(SEED_VIDEO)) return SEED_VIDEO;
  await execFileAsync("ffmpeg", [
    "-f", "lavfi", "-i", "testsrc=duration=10:size=1280x720:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
    "-c:v", "libx264", "-c:a", "aac", "-shortest", "-y",
    SEED_VIDEO,
  ]);
  return SEED_VIDEO;
}

// Dev-only convenience: one POST creates an asset, uploads a generated
// test video, and submits a transcode job — so the dashboard always has
// something live to watch.
export function registerDevRoutes(app: FastifyInstance, videoClient: VideoServiceClient) {
  if (process.env.NODE_ENV === "production") return;

  // Password-less login for seeded test accounts.
  app.post("/v1/dev/login", async (req, reply) => {
    const { email } = (req.body ?? {}) as { email?: string };
    if (!email) return reply.code(400).send({ error: "email is required" });
    return new Promise((resolve) => {
      authClient.issueDevToken({ email }, (err, res) => {
        if (err) {
          resolve(reply.code(err.code === 5 ? 404 : 502).send({ error: err.details || err.message }));
        } else {
          resolve(reply.send({ token: res.token, user: res.user, expiresAt: res.expiresAt }));
        }
      });
    });
  });

  app.post("/v1/dev/seed", { preHandler: requireRole("EDITOR") }, async (req, reply) => {
    const path = await ensureSeedVideo();
    const id = randomUUID().slice(0, 8);
    const storageKey = `uploads/seed-${id}.mp4`;

    await new Upload({
      client: s3,
      params: { Bucket: BUCKET, Key: storageKey, Body: createReadStream(path), ContentType: "video/mp4" },
    }).done();

    const asset = await prisma.asset.create({
      data: {
        orgId: req.authContext!.orgId,
        title: `Seed video ${id}`,
        createdBy: req.authContext!.userId,
        status: "UPLOADED",
        sourceStorageKey: storageKey,
      },
    });

    return new Promise((resolve) => {
      videoClient.submitTranscodeJob(
        {
          context: req.authContext!,
          assetId: asset.id,
          sourceStorageKey: storageKey,
          profile: {
            renditions: [
              { name: "720p", width: 1280, height: 720, videoBitrateKbps: 2500, audioBitrateKbps: 128, videoCodec: 1, audioCodec: 1, framerate: 0 },
              { name: "360p", width: 640, height: 360, videoBitrateKbps: 800, audioBitrateKbps: 96, videoCodec: 1, audioCodec: 1, framerate: 0 },
            ],
            packaging: 1,
            hlsSegmentSeconds: 6,
            generateThumbnails: true,
            thumbnailIntervalSeconds: 10,
            burnInSubtitleAssetId: "",
          },
          priority: 0,
          idempotencyKey: "",
        },
        (err, res) => {
          if (err) {
            resolve(reply.code(502).send({ error: err.details || err.message }));
          } else {
            resolve(reply.code(201).send({ assetId: asset.id, jobId: res.jobId, storageKey }));
          }
        },
      );
    });
  });
}
