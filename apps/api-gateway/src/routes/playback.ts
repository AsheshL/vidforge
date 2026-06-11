import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import type { VideoServiceClient } from "@vidforge/proto/video";
import { requireRole } from "../auth.js";
import { rewritePlaylist } from "../playlist.js";

const BUCKET = process.env.S3_BUCKET ?? "vidforge-media";
// Long enough to watch a video, short enough that a leaked URL goes stale.
const SIGNED_URL_TTL_SECONDS = 900;

const s3 = new S3Client({
  // Must be a browser-reachable endpoint: presigned URLs embed this host.
  endpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: "us-east-1",
  forcePathStyle: true, // required for MinIO
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "vidforge",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "vidforge-secret",
  },
});

async function readBody(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const presign = (key: string) =>
  getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: SIGNED_URL_TTL_SECONDS,
  });

// Serves HLS playlists with segment URIs presigned for direct object-storage
// access. The gateway only ever streams playlist text; media bytes never
// pass through it.
export function registerPlaybackRoutes(app: FastifyInstance, videoClient: VideoServiceClient) {
  app.get("/v1/jobs/:jobId/hls/*", { preHandler: requireRole("VIEWER") }, async (req, reply) => {
    const { jobId, "*": rest } = req.params as { jobId: string; "*": string };

    if (!rest.endsWith(".m3u8")) {
      return reply.code(404).send({ error: "media is served via signed URLs, not the gateway" });
    }
    if (rest.includes("..") || rest.includes("//")) {
      return reply.code(400).send({ error: "invalid path" });
    }

    // Org-scoped ownership check; also rejects jobs without output.
    const manifest = await new Promise<{ playlistStorageKey: string } | null>((resolve) => {
      videoClient.getOutputManifest({ context: req.authContext!, jobId }, (err, res) =>
        resolve(err ? null : res),
      );
    });
    if (!manifest) {
      return reply.code(404).send({ error: "no playable output for this job" });
    }

    const prefix = manifest.playlistStorageKey.replace(/master\.m3u8$/, "");
    const key = `${prefix}${rest}`;
    // Segment URIs in a playlist are relative to the playlist's directory.
    const keyDir = key.slice(0, key.lastIndexOf("/") + 1);

    try {
      const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      const rewritten = await rewritePlaylist(await readBody(obj.Body as Readable), keyDir, presign);
      reply.header("content-type", "application/vnd.apple.mpegurl");
      // Presigned URLs inside expire, so the playlist must not outlive them.
      reply.header("cache-control", `private, max-age=${SIGNED_URL_TTL_SECONDS - 60}`);
      return reply.send(rewritten);
    } catch {
      return reply.code(404).send({ error: "playlist not found" });
    }
  });
}
