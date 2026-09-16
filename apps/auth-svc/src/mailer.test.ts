import { describe, expect, it } from "vitest";
import { smtpOptions } from "./mailer.js";

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
