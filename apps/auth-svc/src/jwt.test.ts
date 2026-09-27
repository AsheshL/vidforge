import { afterEach, describe, expect, it, vi } from "vitest";
import { signToken, verifyJwt } from "./jwt.js";

const claims = { sub: "u1", org: "org1", role: "EDITOR" };

describe("signToken / verifyJwt", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips a signed token", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signToken(claims);
    await expect(verifyJwt(token)).resolves.toMatchObject(claims);
  });

  it("rejects a token signed with an unrelated secret", async () => {
    vi.stubEnv("JWT_SECRET", "secret-a");
    const { token } = await signToken(claims);

    vi.stubEnv("JWT_SECRET", "secret-b");
    await expect(verifyJwt(token)).rejects.toBeDefined();
  });

  describe("secret rotation", () => {
    it("verifies against the current secret", async () => {
      vi.stubEnv("JWT_SECRET", "current-secret");
      vi.stubEnv("JWT_SECRET_PREVIOUS", "");
      const { token } = await signToken(claims);
      await expect(verifyJwt(token)).resolves.toMatchObject(claims);
    });

    it("falls back to the previous secret when the current secret doesn't match", async () => {
      // Sign as if we were still on the pre-rotation secret.
      vi.stubEnv("JWT_SECRET", "old-secret");
      const tokenBeforeRotation = (await signToken(claims)).token;

      // Rotate: current becomes the new secret, old moves to _PREVIOUS.
      vi.stubEnv("JWT_SECRET", "new-secret");
      vi.stubEnv("JWT_SECRET_PREVIOUS", "old-secret");

      await expect(verifyJwt(tokenBeforeRotation)).resolves.toMatchObject(claims);

      // New tokens are signed with only the current secret.
      const tokenAfterRotation = (await signToken(claims)).token;
      await expect(verifyJwt(tokenAfterRotation)).resolves.toMatchObject(claims);
    });

    it("fails when neither the current nor the previous secret matches", async () => {
      vi.stubEnv("JWT_SECRET", "stale-secret");
      const { token } = await signToken(claims);

      vi.stubEnv("JWT_SECRET", "new-secret");
      vi.stubEnv("JWT_SECRET_PREVIOUS", "also-not-it");

      await expect(verifyJwt(token)).rejects.toBeDefined();
    });
  });
});
