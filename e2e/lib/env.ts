// Where the stack under test lives. Defaults match the local dev stack
// (`.claude/skills/run-dev-stack/apps.sh`); override to point elsewhere,
// e.g. the prod-shaped compose stack on :3100/:4100/:8125.
export const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:3000";
export const GATEWAY_URL = process.env.E2E_GATEWAY_URL ?? "http://127.0.0.1:4000";
export const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? "http://127.0.0.1:8025";

// Accounts created by packages/db/prisma/seed.ts. Password-less: sign in
// through the dev-only POST /v1/dev/login.
export const ACCOUNTS = {
  viewer: { email: "viewer@vidforge.test", role: "VIEWER" },
  viewer2: { email: "viewer2@vidforge.test", role: "VIEWER" },
  editor: { email: "editor@vidforge.test", role: "EDITOR" },
  editor2: { email: "editor2@vidforge.test", role: "EDITOR" },
  admin: { email: "admin@vidforge.test", role: "ADMIN" },
  owner: { email: "owner@vidforge.test", role: "OWNER" },
  otherViewer: { email: "viewer@other.test", role: "VIEWER" },
  otherOwner: { email: "owner@other.test", role: "OWNER" },
} as const;
export type AccountName = keyof typeof ACCOUNTS;

// Browser storage states written by global-setup.ts, one per UI role.
export const UI_ROLES = ["viewer", "editor", "admin"] as const satisfies readonly AccountName[];
export const authFile = (role: AccountName) => new URL(`../.auth/${role}.json`, import.meta.url).pathname;

export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
