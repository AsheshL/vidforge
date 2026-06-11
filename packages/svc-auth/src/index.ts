import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestContext } from "@vidforge/proto/common";

// Shared between the gateway (signer) and internal services (verifiers).
// Must differ from JWT_SECRET so a leaked user token can never be replayed
// as a service-to-service credential.
const SECRET = process.env.CONTEXT_SIGNING_SECRET ?? "";
const MAX_AGE_MS = 5 * 60 * 1000;

function requireSecret(): string {
  if (!SECRET) {
    throw new Error("CONTEXT_SIGNING_SECRET is not set");
  }
  return SECRET;
}

// Canonical payload: every identity field the services rely on. Roles are
// sorted so ordering can't produce two valid signatures for one identity.
function payload(ctx: RequestContext, issuedAtMs: number): string {
  return [
    "v1",
    ctx.userId,
    ctx.orgId,
    [...ctx.roles].sort().join(","),
    ctx.traceId,
    String(issuedAtMs),
  ].join("\n");
}

function hmac(data: string): Buffer {
  return createHmac("sha256", requireSecret()).update(data).digest();
}

export function signContext(ctx: Omit<RequestContext, "issuedAtMs" | "signature">): RequestContext {
  const issuedAtMs = Date.now();
  const signature = hmac(payload(ctx as RequestContext, issuedAtMs)).toString("hex");
  return { ...ctx, issuedAtMs, signature };
}

export type ContextVerification =
  | { ok: true; context: RequestContext }
  | { ok: false; reason: string };

export function verifyContext(ctx: RequestContext | undefined): ContextVerification {
  if (!ctx?.userId || !ctx.orgId) {
    return { ok: false, reason: "missing request context" };
  }
  if (!ctx.signature || !ctx.issuedAtMs) {
    return { ok: false, reason: "unsigned request context" };
  }
  const age = Date.now() - Number(ctx.issuedAtMs);
  if (age > MAX_AGE_MS || age < -MAX_AGE_MS) {
    return { ok: false, reason: "request context expired" };
  }
  const expected = hmac(payload(ctx, Number(ctx.issuedAtMs)));
  let actual: Buffer;
  try {
    actual = Buffer.from(ctx.signature, "hex");
  } catch {
    return { ok: false, reason: "malformed context signature" };
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "invalid context signature" };
  }
  return { ok: true, context: ctx };
}
