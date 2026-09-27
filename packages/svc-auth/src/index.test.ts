import { afterEach, describe, expect, it, vi } from "vitest";
import { signContext, verifyContext } from "./index.js";

const base = { userId: "u1", orgId: "org1", roles: ["EDITOR"], traceId: "t1" };

describe("signContext / verifyContext", () => {
  it("round-trips a signed context", () => {
    const result = verifyContext(signContext(base));
    expect(result).toEqual({ ok: true, context: expect.objectContaining(base) });
  });

  it("rejects a missing or incomplete context", () => {
    expect(verifyContext(undefined).ok).toBe(false);
    expect(verifyContext({ ...signContext(base), userId: "" }).ok).toBe(false);
  });

  it("rejects an unsigned context", () => {
    const result = verifyContext({ ...base, issuedAtMs: 0, signature: "" });
    expect(result).toEqual({ ok: false, reason: "unsigned request context" });
  });

  it("rejects when any identity field is tampered", () => {
    const signed = signContext(base);
    for (const patch of [
      { orgId: "victim-org" },
      { userId: "other-user" },
      { roles: ["OWNER"] },
      { issuedAtMs: signed.issuedAtMs + 1 },
    ]) {
      const result = verifyContext({ ...signed, ...patch });
      expect(result.ok, JSON.stringify(patch)).toBe(false);
    }
  });

  it("rejects garbage and truncated signatures", () => {
    const signed = signContext(base);
    expect(verifyContext({ ...signed, signature: "zz" }).ok).toBe(false);
    expect(verifyContext({ ...signed, signature: signed.signature.slice(0, 10) }).ok).toBe(false);
  });

  it("rejects stale and future-dated contexts", () => {
    const signed = signContext(base);
    expect(verifyContext({ ...signed, issuedAtMs: Date.now() - 6 * 60_000 })).toEqual({
      ok: false,
      reason: "request context expired",
    });
    expect(verifyContext({ ...signed, issuedAtMs: Date.now() + 6 * 60_000 }).ok).toBe(false);
  });

  it("treats role order as canonical (sorted before signing)", () => {
    const signed = signContext({ ...base, roles: ["EDITOR", "ADMIN"] });
    const reordered = { ...signed, roles: ["ADMIN", "EDITOR"] };
    expect(verifyContext(reordered).ok).toBe(true);
  });
});

describe("secret rotation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("verifies against the current secret", () => {
    vi.stubEnv("CONTEXT_SIGNING_SECRET", "current-secret");
    vi.stubEnv("CONTEXT_SIGNING_SECRET_PREVIOUS", "");
    const signed = signContext(base);
    expect(verifyContext(signed).ok).toBe(true);
  });

  it("falls back to the previous secret when the current secret doesn't match", () => {
    // Sign as if we were still on the pre-rotation secret.
    vi.stubEnv("CONTEXT_SIGNING_SECRET", "old-secret");
    const signedBeforeRotation = signContext(base);

    // Rotate: current becomes the new secret, old moves to _PREVIOUS.
    vi.stubEnv("CONTEXT_SIGNING_SECRET", "new-secret");
    vi.stubEnv("CONTEXT_SIGNING_SECRET_PREVIOUS", "old-secret");

    expect(verifyContext(signedBeforeRotation)).toEqual({
      ok: true,
      context: expect.objectContaining(base),
    });

    // New signatures use only the current secret.
    const signedAfterRotation = signContext(base);
    expect(signedAfterRotation.signature).not.toBe(signedBeforeRotation.signature);
    expect(verifyContext(signedAfterRotation).ok).toBe(true);
  });

  it("fails when neither the current nor the previous secret matches", () => {
    vi.stubEnv("CONTEXT_SIGNING_SECRET", "stale-secret");
    const signed = signContext(base);

    vi.stubEnv("CONTEXT_SIGNING_SECRET", "new-secret");
    vi.stubEnv("CONTEXT_SIGNING_SECRET_PREVIOUS", "also-not-it");

    expect(verifyContext(signed)).toEqual({ ok: false, reason: "invalid context signature" });
  });
});
