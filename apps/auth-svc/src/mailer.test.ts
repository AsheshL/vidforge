import { afterEach, describe, expect, it, vi } from "vitest";
import { smtpOptions } from "./mailer.js";

describe("mailer module load", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("does not throw on import even when SMTP_URL is not a valid URL", async () => {
    // A freshly-provisioned Secrets Manager value before SES domain
    // verification — this must not crash the whole auth-svc process at
    // boot; only sendInviteEmail (already try/caught by its one caller)
    // should fail once someone actually tries to send.
    vi.stubEnv("SMTP_URL", "REPLACE_ME_AFTER_SES_DOMAIN_VERIFICATION");
    vi.resetModules();

    await expect(import("./mailer.js")).resolves.toBeDefined();
  });

  it("rejects sendInviteEmail (not the whole process) when SMTP_URL is invalid", async () => {
    vi.stubEnv("SMTP_URL", "REPLACE_ME_AFTER_SES_DOMAIN_VERIFICATION");
    vi.resetModules();

    const { sendInviteEmail } = await import("./mailer.js");
    await expect(
      sendInviteEmail({
        to: "a@example.com",
        displayName: "A",
        orgName: "Org",
        inviterName: "B",
        tempPassword: "x",
        expiresAt: new Date(),
        loginUrl: "https://example.com",
      }),
    ).rejects.toThrow();
  });
});

describe("smtpOptions", () => {
  it("reads the dev Mailpit URL without auth or TLS", () => {
    const opts = smtpOptions("smtp://localhost:1025");

    expect(opts.host).toBe("localhost");
    expect(opts.port).toBe(1025);
    expect(opts.secure).toBe(false);
    expect(opts.auth).toBeUndefined();
    // Mailpit speaks neither auth nor STARTTLS; requiring it would break dev.
    expect(opts.requireTLS).toBe(false);
  });

  it("reads SES implicit-TLS credentials", () => {
    const opts = smtpOptions("smtps://AKIAUSER:secret@email-smtp.eu-west-1.amazonaws.com:465");

    expect(opts.host).toBe("email-smtp.eu-west-1.amazonaws.com");
    expect(opts.port).toBe(465);
    expect(opts.secure).toBe(true);
    expect(opts.auth).toEqual({ user: "AKIAUSER", pass: "secret" });
  });

  it("requires STARTTLS whenever credentials go over the submission port", () => {
    const opts = smtpOptions("smtp://AKIAUSER:secret@email-smtp.eu-west-1.amazonaws.com:587");

    expect(opts.secure).toBe(false);
    expect(opts.requireTLS).toBe(true);
  });

  it("url-decodes credentials, which SES passwords need", () => {
    const opts = smtpOptions("smtps://user%40corp:p%2Fa%2Bss@smtp.example.com");

    expect(opts.auth).toEqual({ user: "user@corp", pass: "p/a+ss" });
    // No port given: implicit TLS defaults to 465, submission to 587.
    expect(opts.port).toBe(465);
  });

  it("defaults a portless plain URL to the submission port", () => {
    expect(smtpOptions("smtp://smtp.example.com").port).toBe(587);
  });

  it("pools and paces sends to stay inside the SES quota", () => {
    const opts = smtpOptions("smtps://u:p@smtp.example.com");

    expect(opts.pool).toBe(true);
    expect(opts.maxConnections).toBe(5);
    expect(opts.rateLimit).toBe(14);
    expect(opts.rateDelta).toBe(1_000);
  });
});
