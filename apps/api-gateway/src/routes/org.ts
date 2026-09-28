import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { prisma } from "@vidforge/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authClient, requireRole } from "../auth.js";
import { resolveS3Config } from "../s3-config.js";

const ROLE_NUM: Record<string, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3, OWNER: 4 };

const roleSchema = z.object({
  role: z.enum(["VIEWER", "EDITOR", "ADMIN", "OWNER"]),
});

const createApiKeySchema = z.object({
  name: z.string().min(1).max(80),
  role: z.enum(["VIEWER", "EDITOR", "ADMIN", "OWNER"]),
  expiresAt: z.coerce.date().optional(),
});

const BUCKET = process.env.S3_BUCKET ?? "vidforge-media";
const s3 = new S3Client(resolveS3Config());

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg" };

const identitySchema = z.object({
  displayName: z.string().max(80).optional(),
  // A small data: URI, not a resumable upload: the tus/S3Store path exists
  // for large video files, which a single org logo isn't — this is
  // simpler and good enough for a v1 branding field.
  logoDataUri: z.string().optional(),
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

  // bodyLimit above Fastify's 1MB default: a base64 data URI runs ~33%
  // larger than its decoded bytes, so a request must be let through this
  // far to hit the MAX_LOGO_BYTES check below and get a real 400 instead
  // of a generic 413.
  app.patch("/v1/org", { preHandler: requireRole("ADMIN"), bodyLimit: 6 * 1024 * 1024 }, async (req, reply) => {
    const parsed = identitySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const data: { displayName?: string; logoStorageKey?: string } = {};
    if (parsed.data.displayName !== undefined) data.displayName = parsed.data.displayName;
    if (parsed.data.logoDataUri) {
      const match = /^data:(image\/(?:png|jpeg|svg\+xml));base64,(.+)$/.exec(parsed.data.logoDataUri);
      const ext = match ? LOGO_MIME[match[1]] : undefined;
      if (!ext) return reply.code(400).send({ error: "logo must be a PNG, JPEG or SVG data URI" });
      const buffer = Buffer.from(match![2], "base64");
      if (buffer.byteLength > MAX_LOGO_BYTES) {
        return reply.code(400).send({ error: "logo must be under 2MB" });
      }
      const key = `org-logos/${req.authContext!.orgId}-${randomUUID()}.${ext}`;
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: match![1] }));
      data.logoStorageKey = key;
    }
    const org = await prisma.org.update({ where: { id: req.authContext!.orgId }, data });
    return reply.send({ displayName: org.displayName, logoStorageKey: org.logoStorageKey });
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
