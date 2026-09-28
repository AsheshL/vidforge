import { credentials } from "@grpc/grpc-js";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { AuthServiceClient } from "@vidforge/proto/auth";
import type { RequestContext } from "@vidforge/proto/common";
import type { ViewerContext } from "@vidforge/proto/auth";
import { signContext } from "@vidforge/svc-auth";

export const authClient = new AuthServiceClient(
  process.env.AUTH_SVC_ADDR ?? "localhost:50053",
  credentials.createInsecure(),
);

declare module "fastify" {
  interface FastifyRequest {
    authContext?: RequestContext;
    viewerContext?: ViewerContext;
  }
}

const ROLE_RANK: Record<string, number> = { VIEWER: 1, EDITOR: 2, ADMIN: 3, OWNER: 4 };

export function extractToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  // EventSource can't set headers, so SSE passes the token as a query param.
  const { access_token } = req.query as { access_token?: string };
  return access_token ?? null;
}

function verify(token: string): Promise<RequestContext | null> {
  return new Promise((resolve) => {
    authClient.verifyToken({ token }, (err, res) => {
      if (err || !res.valid || !res.context) return resolve(null);
      resolve(res.context);
    });
  });
}

// preHandler factory: authenticates the request and enforces a minimum role.
export function requireRole(minRole: keyof typeof ROLE_RANK): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = extractToken(req);
    if (!token) {
      return reply.code(401).send({ error: "missing bearer token" });
    }
    const context = await verify(token);
    if (!context) {
      return reply.code(401).send({ error: "invalid or expired token" });
    }
    const rank = Math.max(...context.roles.map((r) => ROLE_RANK[r] ?? 0), 0);
    if (rank < ROLE_RANK[minRole]) {
      return reply.code(403).send({ error: `requires ${minRole} role or higher` });
    }
    // Sign the verified identity so downstream services can prove it came
    // from the gateway, not from whoever can reach their port.
    req.authContext = signContext({ ...context, traceId: req.id });
  };
}

function verifyViewer(token: string): Promise<ViewerContext | null> {
  return new Promise((resolve) => {
    authClient.verifyToken({ token }, (err, res) => {
      if (err || !res.valid || !res.viewerContext) return resolve(null);
      resolve(res.viewerContext);
    });
  });
}

export function requireViewer(): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = extractToken(req);
    if (!token) return reply.code(401).send({ error: "missing bearer token" });
    const viewerContext = await verifyViewer(token);
    if (!viewerContext) return reply.code(401).send({ error: "invalid or expired token" });
    req.viewerContext = viewerContext;
  };
}

// The portal reuses staff-facing internal gRPC calls (e.g. video-svc's
// GetOutputManifest), which expect a signed RequestContext. A viewer has no
// staff role, so we synthesize the lowest one (VIEWER) scoped to their own
// org — enough for the existing org-ownership checks downstream, without
// giving video-svc (or any other internal service) any notion of "viewer."
export function viewerToInternalContext(viewer: ViewerContext, traceId: string): RequestContext {
  return signContext({ userId: viewer.viewerId, orgId: viewer.orgId, roles: ["VIEWER"], traceId });
}
