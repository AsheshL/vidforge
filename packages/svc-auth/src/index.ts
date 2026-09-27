import { createHmac, timingSafeEqual } from "node:crypto";
import type { RequestContext } from "@vidforge/proto/common";
import { tagTraceId } from "@vidforge/otel";

// Shared between the gateway (signer) and internal services (verifiers).
// Must differ from JWT_SECRET so a leaked user token can never be replayed
// as a service-to-service credential.
//
// CONTEXT_SIGNING_SECRET_PREVIOUS is optional and only ever used to verify
// (never to sign). During a secret rotation, the old value is moved there so
// contexts signed by not-yet-redeployed gateway instances still verify
// against downstream services that already picked up the new current
// secret. Read lazily (not cached at module load) so tests can flip
// process.env between cases; in production these are set once at process
// start anyway.
const MAX_AGE_MS = 5 * 60 * 1000;

function currentSecret(): string {
  const secret = process.env.CONTEXT_SIGNING_SECRET ?? "";
  if (!secret) {
    throw new Error("CONTEXT_SIGNING_SECRET is not set");
  }
  return secret;
}

function previousSecret(): string | undefined {
  return process.env.CONTEXT_SIGNING_SECRET_PREVIOUS || undefined;
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

function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function signContext(ctx: Omit<RequestContext, "issuedAtMs" | "signature">): RequestContext {
  const issuedAtMs = Date.now();
  const signature = hmac(currentSecret(), payload(ctx as RequestContext, issuedAtMs)).toString("hex");
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
  const data = payload(ctx, Number(ctx.issuedAtMs));
  let actual: Buffer;
  try {
    actual = Buffer.from(ctx.signature, "hex");
  } catch {
    return { ok: false, reason: "malformed context signature" };
  }

  const candidates = [currentSecret(), previousSecret()].filter((s): s is string => Boolean(s));
  for (const secret of candidates) {
    const expected = hmac(secret, data);
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      // Every RPC that reaches this point is inside the gRPC server span the
      // instrumentation-grpc auto-instrumentation started for it (see
      // packages/otel). Tagging the traceId here — the one choke point every
      // authenticated RPC in every service passes through — correlates that
      // span with the same request's spans in every other service, without
      // needing every call site to remember to do it.
      tagTraceId(ctx.traceId);
      return { ok: true, context: ctx };
    }
  }
  return { ok: false, reason: "invalid context signature" };
}
