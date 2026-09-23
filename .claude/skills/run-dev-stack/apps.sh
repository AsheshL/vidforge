#!/usr/bin/env bash
# Bring up the app services (web, api-gateway, auth-svc, video-svc,
# metadata-svc) via `turbo dev` against the docker dependency stack, and
# verify the whole chain actually works — not just "ports are listening".
#
# Usage:
#   .claude/skills/run-dev-stack/apps.sh          # start everything, verify
#   .claude/skills/run-dev-stack/apps.sh --down   # stop app processes
#
# Logs go to /tmp/vidforge-dev.log.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [[ "${1:-}" == "--down" ]]; then
  pkill -f "turbo run dev" 2>/dev/null || true
  pkill -f "tsx watch src/main.ts" 2>/dev/null || true
  pkill -f "next dev --port 3000" 2>/dev/null || true
  exit 0
fi

echo "--- dependency stack (postgres/redis/minio) ---"
.claude/skills/run-dev-stack/smoke.sh >/dev/null
echo "ok"

echo "--- workspace linking ---"
# pnpm can leave node_modules partially linked (e.g. a workspace package
# added after the last install) without erroring — always re-link.
pnpm install >/dev/null
echo "ok"

echo "--- migration status ---"
status=$(npx --prefix packages/db prisma migrate status --schema packages/db/prisma/schema.prisma 2>&1)
if ! grep -q "Database schema is up to date" <<<"$status"; then
  echo "$status" >&2
  echo "" >&2
  echo "Migration history/schema mismatch — do NOT 'db push'. See SKILL.md" >&2
  echo "Gotchas for how to diagnose (stale/failed migration rows vs. real" >&2
  echo "pending migrations) before touching anything." >&2
  exit 1
fi
echo "ok"

echo "--- seed accounts ---"
# prisma/seed.ts upserts by fixed id, so this is safe to run every time —
# on a fresh DB it creates the accounts, on a reused one it's a no-op.
(set -a; source .env; set +a; pnpm --filter @vidforge/db db:seed) | tail -2

fresh_start=1
if lsof -i :3000 -i :4000 -i :50051 -i :50052 -i :50053 2>/dev/null | grep -q LISTEN; then
  fresh_start=0
  echo "--- app ports already occupied — assuming stack is already up ---"
else
  echo "--- starting apps (turbo dev --env-mode=loose) ---"
  # --env-mode=loose: turbo's default *strict* env mode strips any var not
  # declared in turbo.json's env/globalEnv from every task — DATABASE_URL,
  # REDIS_URL etc. from .env would silently vanish without this flag.
  set -a
  source .env
  set +a
  nohup npx turbo run dev --env-mode=loose > /tmp/vidforge-dev.log 2>&1 &
  disown
  sleep 1
fi

echo "--- waiting for ports ---"
for i in $(seq 1 30); do
  lsof -i :3000 -i :4000 -i :50051 -i :50052 -i :50053 2>/dev/null | grep -q ':50053.*LISTEN' && break
  sleep 1
done
lsof -i :3000 -i :4000 -i :50051 -i :50052 -i :50053 2>/dev/null | grep LISTEN

echo "--- gateway health ---"
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/healthz)
[[ "$code" == "200" ]] || { echo "gateway healthz failed: HTTP $code — check /tmp/vidforge-dev.log" >&2; exit 1; }
echo "healthz: $code"

echo "--- web ---"
code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/)
[[ "$code" == "200" ]] || { echo "web root failed: HTTP $code — check /tmp/vidforge-dev.log" >&2; exit 1; }
echo "root: $code"

echo "--- seeded dev account login ---"
# Password-less /v1/dev/login proves the seeded accounts (see Credentials
# below) actually work end to end, not just that rows exist in postgres.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:4000/v1/dev/login \
  -H "Content-Type: application/json" -d '{"email":"owner@vidforge.test"}')
[[ "$code" == "200" ]] || { echo "dev login for owner@vidforge.test failed: HTTP $code" >&2; exit 1; }
echo "owner@vidforge.test: $code"

if [[ "$fresh_start" == "1" ]]; then
  echo "--- full round trip: signup through the gateway ---"
  # Only on a fresh start — port + healthz checks above already cover the
  # reuse case, and the rate-limit state below is shared via Redis, so it
  # persists across app restarts (not just across requests in one run).
  resp=$(curl -s -X POST http://127.0.0.1:4000/v1/auth/signup \
    -H "Content-Type: application/json" \
    -d "{\"displayName\":\"Smoke Test\",\"email\":\"smoke-$(date +%s)@example.com\",\"password\":\"smoketestpassword123\"}" \
    -w '\n%{http_code}')
  code=$(tail -n1 <<<"$resp")
  case "$code" in
    200|201)
      echo "signup: $code (web -> gateway -> auth-svc -> postgres all reachable)" ;;
    429)
      # Reached the gateway and got a structured app-level response from
      # auth-svc's rate limiter — proves the chain is wired even though
      # this particular request was throttled. Redis-backed limiter state
      # outlives any single run; see Gotchas.
      echo "signup: 429 (rate-limited by a prior run, not a wiring problem — gateway/auth-svc reachable)" ;;
    *)
      echo "signup round trip failed: HTTP $code — $resp" >&2; exit 1 ;;
  esac
fi

echo "--- all app services up and verified — logs: /tmp/vidforge-dev.log ---"
