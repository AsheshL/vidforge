import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authClient, requireRole } from "../auth.js";

const ROLE_NUM: Record<string, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3, OWNER: 4 };

const roleSchema = z.object({
  role: z.enum(["VIEWER", "EDITOR", "ADMIN", "OWNER"]),
});

const createApiKeySchema = z.object({
  name: z.string().min(1).max(80),
  role: z.enum(["VIEWER", "EDITOR", "ADMIN", "OWNER"]),
  expiresAt: z.coerce.date().optional(),
});

// Org administration: member listing, role changes, audit log. Role checks
// beyond the gateway's ADMIN gate (e.g. "cannot outrank the actor") live
// in auth-svc next to the data they protect.
export function registerOrgRoutes(app: FastifyInstance) {
  app.get("/v1/org/members", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    return new Promise((resolve) => {
      authClient.listOrgMembers(
        { context: req.authContext!, page: { pageSize: 100, pageToken: "" } },
        (err, res) => {
          if (err) {
            resolve(reply.code(502).send({ error: err.details || err.message }));
          } else {
            resolve(reply.send(res));
          }
        },
      );
    });
  });

  app.post("/v1/org/members/:userId/role", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return new Promise((resolve) => {
      authClient.assignRole(
        { context: req.authContext!, userId, role: ROLE_NUM[parsed.data.role] },
        (err, res) => {
          if (err) {
            const code = err.code === 5 ? 404 : err.code === 7 ? 403 : 502;
            resolve(reply.code(code).send({ error: err.details || err.message }));
          } else {
            resolve(reply.send(res));
          }
        },
      );
    });
  });

  app.get("/v1/org/audit", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    return new Promise((resolve) => {
      authClient.listAuditEvents(
        {
          context: req.authContext!,
          page: { pageSize: 100, pageToken: "" },
          resourceType: "",
          actorUserId: "",
        },
        (err, res) => {
          if (err) {
            resolve(reply.code(502).send({ error: err.details || err.message }));
          } else {
            resolve(reply.send(res));
          }
        },
      );
    });
  });

  // API keys: management UI for CreateApiKey/RevokeApiKey/ListApiKeys. The
  // plaintext secret is only ever present in the CreateApiKey response body
  // — it is never logged and never stored, here or in auth-svc.
  app.get("/v1/org/api-keys", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    return new Promise((resolve) => {
      authClient.listApiKeys(
        { context: req.authContext!, page: { pageSize: 100, pageToken: "" } },
        (err, res) => {
          if (err) {
            resolve(reply.code(502).send({ error: err.details || err.message }));
          } else {
            resolve(reply.send(res));
          }
        },
      );
    });
  });

  app.post("/v1/org/api-keys", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    const parsed = createApiKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return new Promise((resolve) => {
      authClient.createApiKey(
        {
          context: req.authContext!,
          name: parsed.data.name,
          role: ROLE_NUM[parsed.data.role],
          expiresAt: parsed.data.expiresAt,
        },
        (err, res) => {
          if (err) {
            const code = err.code === 7 ? 403 : err.code === 3 ? 400 : 502;
            resolve(reply.code(code).send({ error: err.details || err.message }));
          } else {
            resolve(reply.code(201).send(res));
          }
        },
      );
    });
  });

  app.post("/v1/org/api-keys/:keyId/revoke", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    const { keyId } = req.params as { keyId: string };
    return new Promise((resolve) => {
      authClient.revokeApiKey({ context: req.authContext!, keyId }, (err, res) => {
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
