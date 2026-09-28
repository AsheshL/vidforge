import type { FastifyInstance } from "fastify";
import { prisma } from "@vidforge/db";
import { z } from "zod";
import { requireRole } from "../auth.js";

// Org-scoped asset listing with each asset's latest completed job so the
// UI can link straight to playback. Reads Postgres directly like the dev
// seed route does; moves behind metadata-svc when that service lands.
export function registerAssetRoutes(app: FastifyInstance) {
  app.get("/v1/assets", { preHandler: requireRole("VIEWER") }, async (req) => {
    const { pageSize, pageToken } = req.query as { pageSize?: string; pageToken?: string };
    const size = Math.min(Math.max(Number(pageSize) || 50, 1), 100);
    const where = { orgId: req.authContext!.orgId };
    // Cursor pagination keyed on the previous page's last asset id, mirroring
    // ListJobs. The id tiebreaker makes the (createdAt, id) ordering total,
    // so the cursor is stable even when assets share a timestamp.
    const [assets, totalCount] = await Promise.all([
      prisma.asset.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: size,
        ...(pageToken ? { cursor: { id: pageToken }, skip: 1 } : {}),
        include: {
          jobs: {
            where: { state: "COMPLETED" },
            orderBy: { finishedAt: "desc" },
            take: 1,
            select: { id: true },
          },
        },
      }),
      prisma.asset.count({ where }),
    ]);
    return {
      assets: assets.map((a) => ({
        assetId: a.id,
        title: a.title,
        status: a.status,
        sourceStorageKey: a.sourceStorageKey,
        // BigInt isn't JSON-serializable
        sourceBytes: a.sourceBytes === null ? null : Number(a.sourceBytes),
        durationSeconds: a.durationSeconds,
        createdBy: a.createdBy,
        createdAt: a.createdAt,
        latestCompletedJobId: a.jobs[0]?.id ?? null,
      })),
      pageInfo: {
        nextPageToken: assets.length === size ? assets[assets.length - 1].id : "",
        totalCount,
      },
    };
  });

  const publishSchema = z.object({ published: z.boolean() });

  app.patch("/v1/assets/:id/publish", { preHandler: requireRole("EDITOR") }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const asset = await prisma.asset.findFirst({ where: { id, orgId: req.authContext!.orgId } });
    if (!asset) return reply.code(404).send({ error: "no such asset" });
    const updated = await prisma.asset.update({
      where: { id },
      data: { publishedAt: parsed.data.published ? new Date() : null },
    });
    return reply.send({ assetId: updated.id, publishedAt: updated.publishedAt });
  });
}
