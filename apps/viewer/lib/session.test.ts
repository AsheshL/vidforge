import { describe, expect, it } from "vitest";
import { tokenKey, userKey } from "./session";

describe("session key scoping", () => {
  it("scopes the token key by orgSlug, distinct from apps/web's key", () => {
    expect(tokenKey("acme-inc")).toBe("vidforge.viewer.token.acme-inc");
    expect(tokenKey("other-org")).toBe("vidforge.viewer.token.other-org");
    expect(tokenKey("acme-inc")).not.toBe(tokenKey("other-org"));
  });

  it("scopes the user key by orgSlug the same way", () => {
    expect(userKey("acme-inc")).toBe("vidforge.viewer.user.acme-inc");
  });
});
