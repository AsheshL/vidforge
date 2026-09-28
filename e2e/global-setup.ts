import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { request } from "@playwright/test";
import { Redis } from "ioredis";
import { ACCOUNTS, authFile, GATEWAY_URL, UI_ROLES, WEB_URL } from "./lib/env.js";

const ROLE_NAMES: Record<number, string> = { 1: "VIEWER", 2: "EDITOR", 3: "ADMIN", 4: "OWNER" };

async function check(url: string, what: string) {
  const ctx = await request.newContext();
  try {
    const res = await ctx.get(url, { timeout: 10_000 });
    if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
  } catch (err) {
    throw new Error(
      `${what} is not reachable at ${url} (${(err as Error).message}). Start the stack first: ` +
        `.claude/skills/run-dev-stack/apps.sh (and \`docker compose up -d mailpit\` for invite emails).`,
    );
  } finally {
    await ctx.dispose();
  }
}

export default async function globalSetup() {
  await check(`${GATEWAY_URL}/healthz`, "api-gateway");
  await check(WEB_URL, "web");

  // Auth endpoints are rate-limited per IP with Redis-backed counters that
  // outlive restarts (signup: 5 per 15 min). Repeated local runs would trip
  // them, so clear this namespace first. Local stacks only.
  if (process.env.E2E_RESET_RATE_LIMITS !== "0") {
    const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    try {
      await redis.connect();
      const keys = await redis.keys("vidforge:rl:*");
      if (keys.length) await redis.del(...keys);
    } catch (err) {
      console.warn(`could not reset rate limits (${(err as Error).message}); signup/invite tests may hit 429`);
    } finally {
      redis.disconnect();
    }
  }

  // Signed-in browser state per UI role: the web app keeps its session in
  // localStorage (vidforge.token / vidforge.user, see apps/web/lib/api.ts).
  const ctx = await request.newContext();
  for (const role of UI_ROLES) {
    const res = await ctx.post(`${GATEWAY_URL}/v1/dev/login`, { data: { email: ACCOUNTS[role].email } });
    if (!res.ok()) throw new Error(`dev login for ${role} failed: HTTP ${res.status()} — is the DB seeded?`);
    const { token, user } = await res.json();
    const state = {
      cookies: [],
      origins: [
        {
          origin: new URL(WEB_URL).origin,
          localStorage: [
            { name: "vidforge.token", value: token },
            { name: "vidforge.user", value: JSON.stringify({ ...user, role: ROLE_NAMES[user.role] ?? user.role }) },
          ],
        },
      ],
    };
    await mkdir(dirname(authFile(role)), { recursive: true });
    await writeFile(authFile(role), JSON.stringify(state, null, 2));
  }
  await ctx.dispose();
}
