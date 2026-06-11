import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authClient, requireRole } from "../auth.js";

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(80),
  orgName: z.string().max(80).default(""),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const ROLE_NUM: Record<string, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3, OWNER: 4 };

const inviteSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(80),
  role: z.enum(["VIEWER", "EDITOR", "ADMIN", "OWNER"]).default("VIEWER"),
});

const bulkInviteSchema = z.object({
  invites: z.array(inviteSchema).min(1).max(50),
});

const changePasswordSchema = z.object({
  email: z.string().email(),
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

// gRPC status → HTTP for the two auth entry points.
const GRPC_HTTP: Record<number, number> = { 3: 400, 6: 409, 16: 401 };

// Per-IP limits on the unauthenticated endpoints: tight enough to make
// credential stuffing and signup floods impractical, loose enough that a
// fumbled password or a small team onboarding never hits them.
const LIMITS = {
  signup: { max: 5, timeWindow: "15 minutes" },
  login: { max: 10, timeWindow: "1 minute" },
  changePassword: { max: 5, timeWindow: "1 minute" },
  invites: { max: 30, timeWindow: "1 hour" },
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

export function registerAccountRoutes(app: FastifyInstance) {
  app.post("/v1/auth/signup", { config: rateLimited(LIMITS.signup) }, async (req, reply) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return new Promise((resolve) => {
      authClient.signUp(parsed.data, (err, res) => {
        if (err) {
          resolve(reply.code(GRPC_HTTP[err.code] ?? 502).send({ error: err.details || err.message }));
        } else {
          resolve(reply.code(201).send(res));
        }
      });
    });
  });

  app.post("/v1/auth/login", { config: rateLimited(LIMITS.login) }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return new Promise((resolve) => {
      authClient.login(parsed.data, (err, res) => {
        if (err) {
          resolve(reply.code(GRPC_HTTP[err.code] ?? 502).send({ error: err.details || err.message }));
        } else if (res.passwordChangeRequired) {
          // Correct temp password, but no session: client must collect a
          // new password and call /v1/auth/change-password.
          resolve(reply.code(403).send({ code: "PASSWORD_CHANGE_REQUIRED", error: "set a new password to continue" }));
        } else {
          resolve(reply.send(res));
        }
      });
    });
  });

  app.post("/v1/auth/change-password", { config: rateLimited(LIMITS.changePassword) }, async (req, reply) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return new Promise((resolve) => {
      authClient.changePassword(parsed.data, (err, res) => {
        if (err) {
          resolve(reply.code(GRPC_HTTP[err.code] ?? 502).send({ error: err.details || err.message }));
        } else {
          resolve(reply.send(res));
        }
      });
    });
  });

  // Bulk invite: processes sequentially, reporting per-row success or
  // failure (e.g. duplicate emails) without aborting the batch.
  app.post(
    "/v1/org/invites/bulk",
    { preHandler: requireRole("ADMIN"), config: rateLimited(LIMITS.invites) },
    async (req, reply) => {
      const parsed = bulkInviteSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }
      const results = [];
      for (const invite of parsed.data.invites) {
        const result = await new Promise<{ email: string; ok: boolean; error?: string }>((resolve) => {
          authClient.inviteUser(
            {
              context: req.authContext!,
              email: invite.email,
              displayName: invite.displayName,
              role: ROLE_NUM[invite.role],
            },
            (err) => {
              resolve(
                err
                  ? { email: invite.email, ok: false, error: err.details || err.message }
                  : { email: invite.email, ok: true },
              );
            },
          );
        });
        results.push(result);
      }
      const invited = results.filter((r) => r.ok).length;
      return reply.code(invited > 0 ? 201 : 400).send({ invited, failed: results.length - invited, results });
    },
  );

  app.post("/v1/org/invites", { preHandler: requireRole("ADMIN"), config: rateLimited(LIMITS.invites) }, async (req, reply) => {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return new Promise((resolve) => {
      authClient.inviteUser(
        {
          context: req.authContext!,
          email: parsed.data.email,
          displayName: parsed.data.displayName,
          role: ROLE_NUM[parsed.data.role],
        },
        (err, res) => {
          if (err) {
            const code = err.code === 7 ? 403 : GRPC_HTTP[err.code] ?? 502;
            resolve(reply.code(code).send({ error: err.details || err.message }));
          } else {
            resolve(reply.code(201).send(res));
          }
        },
      );
    });
  });
}
