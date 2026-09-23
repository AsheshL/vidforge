#!/usr/bin/env bash
# Bring up the local dev dependency stack (postgres, redis, minio — and
# mailpit if requested) and prove each one is actually reachable, not just
# "container running". Idempotent: safe to re-run against an already-up
# stack.
#
# Usage:
#   .claude/skills/run-dev-stack/smoke.sh              # postgres+redis+minio
#   .claude/skills/run-dev-stack/smoke.sh --with-mail   # + mailpit
#   .claude/skills/run-dev-stack/smoke.sh --down        # tear down (keeps volumes)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [[ "${1:-}" == "--down" ]]; then
  docker compose down
  exit 0
fi

services=(postgres redis minio)
[[ "${1:-}" == "--with-mail" ]] && services+=(mailpit)

docker compose up -d "${services[@]}"

echo "--- waiting for containers to report healthy ---"
for i in $(seq 1 30); do
  docker compose exec -T postgres pg_isready -U vidforge -d vidforge >/dev/null 2>&1 && break
  sleep 1
done

echo "--- postgres ---"
docker compose exec -T postgres pg_isready -U vidforge -d vidforge

echo "--- redis ---"
docker compose exec -T redis redis-cli ping

echo "--- minio ---"
code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:9000/minio/health/live)
[[ "$code" == "200" ]] || { echo "minio health check failed: HTTP $code" >&2; exit 1; }
echo "health: $code"

# Ensure the bucket the apps expect (S3_BUCKET in .env.example) exists.
# mc mb -p is idempotent — no-ops if the bucket is already there.
docker compose exec -T minio sh -c '
  mc alias set local http://localhost:9000 vidforge vidforge-secret >/dev/null 2>&1
  mc mb -p local/vidforge-media >/dev/null 2>&1 || true
  mc ls local
'

if [[ " ${services[*]} " == *" mailpit "* ]]; then
  echo "--- mailpit ---"
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8025/api/v1/messages)
  [[ "$code" == "200" ]] || { echo "mailpit API check failed: HTTP $code" >&2; exit 1; }
  echo "api: $code"
fi

echo "--- all dependencies up and verified ---"
