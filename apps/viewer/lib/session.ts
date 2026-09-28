// Every org's portal is served from this one app at a different /:orgSlug
// path, so session state MUST be keyed by orgSlug — a single shared key
// (the way apps/web does it, since apps/web only ever has one org's staff
// logged in per browser profile) would let a session for org A leak into
// org B's portal in the same browser. See the plan's Review Focus #1.
export function tokenKey(orgSlug: string): string {
  return `vidforge.viewer.token.${orgSlug}`;
}

export function userKey(orgSlug: string): string {
  return `vidforge.viewer.user.${orgSlug}`;
}
