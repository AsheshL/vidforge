import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("verifies the original password", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("rightpassword");
    expect(await verifyPassword("wrongpassword", stored)).toBe(false);
  });

  it("produces unique salts per hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    expect(a).not.toEqual(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("rejects malformed stored values without throwing", async () => {
    for (const bad of ["", "plaintext", "bcrypt:aa:bb", "scrypt:onlysalt"]) {
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
  });
});
