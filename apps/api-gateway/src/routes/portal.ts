import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@vidforge/db";
import type { VideoServiceClient } from "@vidforge/proto/video";
import { authClient, requireViewer, viewerToInternalContext } from "../auth.js";
import { fetchHlsPlaylist, fetchThumbnailUrls, presign, SIGNED_URL_TTL_SECONDS } from "./playback.js";

const activateSchema = z.object({
  orgSlug: z.string().min(1),
  token: z.string().min(1),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  orgSlug: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(1),
});

const GRPC_HTTP: Record<number, number> = { 3: 400, 5: 404, 6: 409, 7: 403, 16: 401 };

const LIMITS = {
  login: { max: 10, timeWindow: "1 minute" },
  activate: { max: 10, timeWindow: "15 minutes" },
} as const;

function rateLimited(limit: { max: number; timeWindow: string }) {
  return {
    rateLimit: {
      ...limit,
      errorResponseBuilder: (_req: unknown, ctx: { ttl: number }) => ({
        statusCode: 429,
        error: `too many attempts, retry in ${Math.ceil(ctx.ttl / 1000)}s`,
      }),
    },
  };
}

export function registerPortalRoutes(app: FastifyInstance, videoClient: VideoServiceClient) {
  app.get("/v1/portal/org/:orgSlug", async (req, reply) => {
    const { orgSlug } = req.params as { orgSlug: string };
    const org = await prisma.org.findUnique({
      where: { slug: orgSlug },
      select: { displayName: true, name: true, logoStorageKey: true },
    });
    if (!org) return reply.code(404).send({ error: "no such org" });
    return reply.send({
      displayName: org.displayName || org.name,
      logoUrl: org.logoStorageKey ? await presign(org.logoStorageKey) : null,
    });
  });

  app.post("/v1/portal/auth/activate", { config: rateLimited(LIMITS.activate) }, async (req, reply) => {
    const parsed = activateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return new Promise((resolve) => {
      authClient.activateViewer(parsed.data, (err, res) => {
        if (err) {
          resolve(reply.code(GRPC_HTTP[err.code] ?? 502).send({ error: err.details || err.message }));
        } else {
          resolve(reply.send(res));
        }
      });
    });
  });

  app.post("/v1/portal/auth/login", { config: rateLimited(LIMITS.login) }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return new Promise((resolve) => {
      authClient.viewerLogin(parsed.data, (err, res) => {
        if (err) {
          resolve(reply.code(GRPC_HTTP[err.code] ?? 502).send({ error: err.details || err.message }));
        } else {
          resolve(reply.send(res));
        }
      });
    });
  });

  app.get("/v1/portal/library", { preHandler: requireViewer() }, async (req, reply) => {
    const { pageSize, pageToken, q } = req.query as { pageSize?: string; pageToken?: string; q?: string };
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 100);
    const where = {
      orgId: req.viewerContext!.orgId,
      publishedAt: { not: null },
      ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}),
    };
    const [assets, totalCount] = await Promise.all([
      prisma.asset.findMany({
        where,
        orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
        take: size,
        ...(pageToken ? { cursor: { id: pageToken }, skip: 1 } : {}),
        include: {
          jobs: { where: { state: "COMPLETED" }, orderBy: { finishedAt: "desc" }, take: 1, select: { id: true } },
        },
      }),
      prisma.asset.count({ where }),
    ]);
    return reply.send({
      assets: assets.map((a) => ({
        assetId: a.id,
        title: a.title,
        durationSeconds: a.durationSeconds,
        latestCompletedJobId: a.jobs[0]?.id ?? null,
      })),
      pageInfo: { nextPageToken: assets.length === size ? assets[assets.length - 1].id : "", totalCount },
    });
  });

  // Playback is additionally gated on the asset being published — video-svc's
  // GetOutputManifest only knows about org ownership, not publish state, so
  // that check happens here before we ever call it.
  async function requirePublishedJob(orgId: string, jobId: string): Promise<boolean> {
    const job = await prisma.transcodeJob.findFirst({
      where: { id: jobId, orgId, asset: { publishedAt: { not: null } } },
      select: { id: true },
    });
    return job !== null;
  }

  app.get("/v1/portal/jobs/:jobId/hls/*", { preHandler: requireViewer() }, async (req, reply) => {
    const { jobId, "*": rest } = req.params as { jobId: string; "*": string };
    const viewer = req.viewerContext!;
    if (!(await requirePublishedJob(viewer.orgId, jobId))) {
      return reply.code(404).send({ error: "no playable output for this job" });
    }
    const context = viewerToInternalContext(viewer, req.id);
    const result = await fetchHlsPlaylist(videoClient, context, jobId, rest);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    reply.header("content-type", result.contentType);
    reply.header("cache-control", result.cacheControl);
    return reply.send(result.body);
  });

  app.get("/v1/portal/jobs/:jobId/thumbnails", { preHandler: requireViewer() }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const viewer = req.viewerContext!;
    reply.header("cache-control", `private, max-age=${SIGNED_URL_TTL_SECONDS - 60}`);
    if (!(await requirePublishedJob(viewer.orgId, jobId))) {
      return reply.send({ thumbnails: [] });
    }
    const context = viewerToInternalContext(viewer, req.id);
    const thumbnails = await fetchThumbnailUrls(videoClient, context, jobId);
    return reply.send({ thumbnails });
  });

  app.get("/v1/portal/progress", { preHandler: requireViewer() }, async (req, reply) => {
    const rows = await prisma.watchProgress.findMany({
      where: { viewerId: req.viewerContext!.viewerId },
      orderBy: { updatedAt: "desc" },
    });
    return reply.send({
      progress: rows.map((r) => ({ assetId: r.assetId, positionSeconds: r.positionSeconds, updatedAt: r.updatedAt })),
    });
  });

  const progressSchema = z.object({ positionSeconds: z.number().min(0) });

  app.put("/v1/portal/progress/:assetId", { preHandler: requireViewer() }, async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const parsed = progressSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const viewer = req.viewerContext!;
    const asset = await prisma.asset.findFirst({ where: { id: assetId, orgId: viewer.orgId } });
    if (!asset) return reply.code(404).send({ error: "no such asset" });
    const row = await prisma.watchProgress.upsert({
      where: { viewerId_assetId: { viewerId: viewer.viewerId, assetId } },
      create: { viewerId: viewer.viewerId, assetId, positionSeconds: parsed.data.positionSeconds },
      update: { positionSeconds: parsed.data.positionSeconds },
    });
    return reply.send({ assetId: row.assetId, positionSeconds: row.positionSeconds, updatedAt: row.updatedAt });
  });

  app.get("/v1/portal/history", { preHandler: requireViewer() }, async (req, reply) => {
    const rows = await prisma.watchProgress.findMany({
      where: { viewerId: req.viewerContext!.viewerId },
      orderBy: { updatedAt: "desc" },
      include: {
        asset: {
          select: {
            title: true, publishedAt: true,
            jobs: { where: { state: "COMPLETED" }, orderBy: { finishedAt: "desc" }, take: 1, select: { id: true } },
          },
        },
      },
    });
    return reply.send({
      history: rows.map((r) => ({
        assetId: r.assetId,
        title: r.asset.title,
        positionSeconds: r.positionSeconds,
        updatedAt: r.updatedAt,
        available: r.asset.publishedAt !== null,
        latestCompletedJobId: r.asset.jobs[0]?.id ?? null,
      })),
    });
  });
}
