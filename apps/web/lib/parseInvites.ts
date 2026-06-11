export interface ParsedInvite {
  displayName: string;
  email: string;
  role: string;
}

const ROLES = new Set(["VIEWER", "EDITOR", "ADMIN"]);

// One invite per line: "Name, email[, role]". Role defaults to VIEWER.
export function parseInvites(text: string): { invites: ParsedInvite[]; errors: string[] } {
  const invites: ParsedInvite[] = [];
  const errors: string[] = [];
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(",").map((p) => p.trim());
    const [displayName, email, role = "VIEWER"] = parts;
    if (!displayName || !email?.includes("@")) {
      errors.push(`line ${i + 1}: expected "Name, email[, role]"`);
      continue;
    }
    if (!ROLES.has(role.toUpperCase())) {
      errors.push(`line ${i + 1}: role must be VIEWER, EDITOR or ADMIN`);
      continue;
    }
    invites.push({ displayName, email, role: role.toUpperCase() });
  }
  return { invites, errors };
}
