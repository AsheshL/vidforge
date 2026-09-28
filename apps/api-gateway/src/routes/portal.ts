import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@vidforge/db";
import type { VideoServiceClient } from "@vidforge/proto/video";
import { authClient } from "../auth.js";
import { presign } from "./playback.js";

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

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- consumed by Task 11/12
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
}
