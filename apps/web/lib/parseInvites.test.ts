import { describe, expect, it } from "vitest";
import { parseInvites } from "./parseInvites";

describe("parseInvites", () => {
  it("parses valid lines with and without explicit roles", () => {
    const { invites, errors } = parseInvites(
      "Ada Lovelace, ada@example.com, EDITOR\nGrace Hopper, grace@example.com",
    );
    expect(errors).toEqual([]);
    expect(invites).toEqual([
      { displayName: "Ada Lovelace", email: "ada@example.com", role: "EDITOR" },
      { displayName: "Grace Hopper", email: "grace@example.com", role: "VIEWER" },
    ]);
  });

  it("skips blank lines and normalizes role case", () => {
    const { invites, errors } = parseInvites("\n\nBob, bob@x.test, admin\n\n");
    expect(errors).toEqual([]);
    expect(invites).toEqual([{ displayName: "Bob", email: "bob@x.test", role: "ADMIN" }]);
  });

  it("reports line numbers for malformed rows", () => {
    const { invites, errors } = parseInvites("good, g@x.test\nmissing-email\n, no@name.test");
    expect(invites).toHaveLength(1);
    expect(errors).toEqual([
      'line 2: expected "Name, email[, role]"',
      'line 3: expected "Name, email[, role]"',
    ]);
  });

  it("rejects OWNER and unknown roles", () => {
    const { invites, errors } = parseInvites("A, a@x.test, OWNER\nB, b@x.test, SUPERUSER");
    expect(invites).toEqual([]);
    expect(errors).toHaveLength(2);
  });
});
