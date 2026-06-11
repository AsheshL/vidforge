import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authClient, requireRole } from "../auth.js";

const ROLE_NUM: Record<string, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3, OWNER: 4 };

const roleSchema = z.object({
  role: z.enum(["VIEWER", "EDITOR", "ADMIN", "OWNER"]),
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
}
