import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import type { VideoServiceClient } from "@vidforge/proto/video";
import type { RequestContext } from "@vidforge/proto/common";
import { requireRole } from "../auth.js";
import { rewritePlaylist } from "../playlist.js";
import { resolveS3Config } from "../s3-config.js";

const BUCKET = process.env.S3_BUCKET ?? "vidforge-media";

export const SIGNED_URL_TTL_SECONDS = 900;

const s3 = new S3Client(resolveS3Config());
const s3Public = new S3Client(resolveS3Config(process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT));

async function readBody(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export const presign = (key: string) =>
  getSignedUrl(s3Public, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: SIGNED_URL_TTL_SECONDS,
  });

export type HlsPlaylistResult = {
  ok: true;
  body: string;
  contentType: string;
  cacheControl: string;
};
export type PlaybackError = { ok: false; status: number; error: string };

// Shared by the staff (`/v1/jobs/...`) and portal (`/v1/portal/jobs/...`)
// routes: the manifest fetch, presign, and playlist rewrite are identical —
// only the RequestContext passed in (and, for the portal, an extra publish
// check the caller does before calling this) differs.
export async function fetchHlsPlaylist(
  videoClient: VideoServiceClient,
  context: RequestContext,
  jobId: string,
  rest: string,
): Promise<HlsPlaylistResult | PlaybackError> {
  if (!rest.endsWith(".m3u8")) {
    return { ok: false, status: 404, error: "media is served via signed URLs, not the gateway" };
  }
  if (rest.includes("..") || rest.includes("//")) {
    return { ok: false, status: 400, error: "invalid path" };
  }

  const manifest = await new Promise<{ playlistStorageKey: string } | null>((resolve) => {
    videoClient.getOutputManifest({ context, jobId }, (err, res) => resolve(err ? null : res));
  });
  if (!manifest) {
    return { ok: false, status: 404, error: "no playable output for this job" };
  }

  const prefix = manifest.playlistStorageKey.replace(/master\.m3u8$/, "");
  const key = `${prefix}${rest}`;
  const keyDir = key.slice(0, key.lastIndexOf("/") + 1);

  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const rewritten = await rewritePlaylist(await readBody(obj.Body as Readable), keyDir, presign);
    return {
      ok: true,
      body: rewritten,
      contentType: "application/vnd.apple.mpegurl",
      cacheControl: `private, max-age=${SIGNED_URL_TTL_SECONDS - 60}`,
    };
  } catch {
    return { ok: false, status: 404, error: "playlist not found" };
  }
}

export async function fetchThumbnailUrls(
  videoClient: VideoServiceClient,
  context: RequestContext,
  jobId: string,
): Promise<string[]> {
  const manifest = await new Promise<{ thumbnailStorageKeys: string[] } | null>((resolve) => {
    videoClient.getOutputManifest({ context, jobId }, (err, res) => resolve(err ? null : res));
  });
  const keys = manifest?.thumbnailStorageKeys ?? [];
  return Promise.all(keys.map((key) => presign(key)));
}

export function registerPlaybackRoutes(app: FastifyInstance, videoClient: VideoServiceClient) {
  app.get("/v1/jobs/:jobId/hls/*", { preHandler: requireRole("VIEWER") }, async (req, reply) => {
    const { jobId, "*": rest } = req.params as { jobId: string; "*": string };
    const result = await fetchHlsPlaylist(videoClient, req.authContext!, jobId, rest);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    reply.header("content-type", result.contentType);
    reply.header("cache-control", result.cacheControl);
    return reply.send(result.body);
  });

  app.get("/v1/jobs/:jobId/thumbnails", { preHandler: requireRole("VIEWER") }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    reply.header("cache-control", `private, max-age=${SIGNED_URL_TTL_SECONDS - 60}`);
    const thumbnails = await fetchThumbnailUrls(videoClient, req.authContext!, jobId);
    return reply.send({ thumbnails });
  });
}
