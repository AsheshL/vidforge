import type { FastifyInstance } from "fastify";
import { prisma } from "@vidforge/db";
import { requireRole } from "../auth.js";

// Org-scoped asset listing with each asset's latest completed job so the
// UI can link straight to playback. Reads Postgres directly like the dev
// seed route does; moves behind metadata-svc when that service lands.
export function registerAssetRoutes(app: FastifyInstance) {
  app.get("/v1/assets", { preHandler: requireRole("VIEWER") }, async (req) => {
    const assets = await prisma.asset.findMany({
      where: { orgId: req.authContext!.orgId },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        jobs: {
          where: { state: "COMPLETED" },
          orderBy: { finishedAt: "desc" },
          take: 1,
          select: { id: true },
        },
      },
    });
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
    };
  });
}
