import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "./config.js";

describe("parseTrustProxy", () => {
  it("defaults to off so X-Forwarded-For can't be spoofed", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("   ")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("0")).toBe(false);
  });

  it("enables blanket trust for 'true'", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy(" true ")).toBe(true);
  });

  it("reads a hop count as a number", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("2")).toBe(2);
  });

  it("passes an address list through to proxy-addr", () => {
    expect(parseTrustProxy("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(parseTrustProxy("127.0.0.1,10.0.0.0/8")).toBe("127.0.0.1,10.0.0.0/8");
  });
});
