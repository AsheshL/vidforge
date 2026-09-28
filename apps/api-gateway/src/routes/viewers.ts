import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authClient, requireRole } from "../auth.js";

const inviteSchema = z.object({ email: z.string().email() });

const LIMITS = { invite: { max: 30, timeWindow: "1 hour" } } as const;

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

export function registerViewerRoutes(app: FastifyInstance) {
  app.post(
    "/v1/viewers/invite",
    { preHandler: requireRole("ADMIN"), config: rateLimited(LIMITS.invite) },
    async (req, reply) => {
      const parsed = inviteSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      return new Promise((resolve) => {
        authClient.inviteViewer({ context: req.authContext!, email: parsed.data.email }, (err, res) => {
          if (err) {
            const code = err.code === 7 ? 403 : err.code === 6 ? 409 : err.code === 3 ? 400 : 502;
            resolve(reply.code(code).send({ error: err.details || err.message }));
          } else {
            resolve(reply.code(201).send(res));
          }
        });
      });
    },
  );

  app.get("/v1/viewers", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    return new Promise((resolve) => {
      authClient.listViewers({ context: req.authContext!, page: { pageSize: 100, pageToken: "" } }, (err, res) => {
        if (err) {
          resolve(reply.code(502).send({ error: err.details || err.message }));
        } else {
          resolve(reply.send(res));
        }
      });
    });
  });

  app.post("/v1/viewers/:viewerId/revoke", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    const { viewerId } = req.params as { viewerId: string };
    return new Promise((resolve) => {
      authClient.revokeViewer({ context: req.authContext!, viewerId }, (err, res) => {
        if (err) {
          const code = err.code === 5 ? 404 : 502;
          resolve(reply.code(code).send({ error: err.details || err.message }));
        } else {
          resolve(reply.send(res));
        }
      });
    });
  });
}
