---
name: run-dev-stack
description: Bring up and verify the local dev/testing stack — postgres, redis, minio, mailpit via docker compose, and (with apps.sh) the full app stack (web, api-gateway, auth-svc, video-svc, metadata-svc) via turbo dev. Use when asked to run, start, or test the dev stack, spin up dependencies or the app services for testing, or check that postgres/redis/minio/the apps are up and reachable.
---

All paths below are relative to the repo root (`video-fs/`).

This repo's apps (`apps/*`) don't run in docker for local dev — only
their *dependencies* do: postgres, redis, minio (S3-compatible
storage), and mailpit (SMTP catcher). `docker compose up -d` alone
proves the containers started; it does **not** prove postgres is
accepting connections, or that the S3 bucket the apps expect
(`vidforge-media`, from `.env.example`'s `S3_BUCKET`) exists yet.
`smoke.sh` checks all of that. `apps.sh` goes further and brings up
the Node app services on top, since `turbo dev` has its own sharp
edges (see Gotchas) that silently produce a stack that *looks* up but
can't actually complete a request.

## Run (agent path)

### Dependencies only

```bash
.claude/skills/run-dev-stack/smoke.sh              # postgres + redis + minio
.claude/skills/run-dev-stack/smoke.sh --with-mail   # + mailpit
.claude/skills/run-dev-stack/smoke.sh --down        # stop (keeps volumes)
```

Idempotent — safe to re-run against an already-up stack. It:

1. `docker compose up -d` the requested services.
2. Polls `pg_isready` until postgres accepts connections (up to 30s).
3. Confirms redis answers `PING` with `PONG`.
4. Confirms minio's `/minio/health/live` returns `200`.
5. Creates the `vidforge-media` bucket via `mc mb -p` (no-op if it
   already exists) and lists buckets so you can see it's there.
6. With `--with-mail`, also checks mailpit's REST API
   (`GET /api/v1/messages`) returns `200`.

Any failed check exits non-zero with the HTTP code / output that
failed — don't treat "containers Running" as success on its own.

### Full app stack (web + api-gateway + auth-svc + video-svc + metadata-svc)

```bash
.claude/skills/run-dev-stack/apps.sh          # deps + apps, verified end to end
.claude/skills/run-dev-stack/apps.sh --down   # stop app processes (deps stay up)
```

Idempotent — safe to re-run. It:

1. Runs `smoke.sh` (deps must be up and verified first).
2. Runs `pnpm install` — repairs partial workspace symlinks (see
   Gotchas). Fast no-op when already linked.
3. Runs `prisma migrate status` and **fails loudly with the raw output**
   if the schema isn't "up to date" — does not attempt to auto-fix, since
   the right fix depends on *why* it's not clean (see Gotchas below and
   the Troubleshooting entry for the specific drift already hit once).
4. If the app ports are free, starts everything with
   `turbo run dev --env-mode=loose` (background, logs to
   `/tmp/vidforge-dev.log`) and waits for ports to open. If already
   occupied, assumes the stack is up and skips straight to verification.
5. Checks `GET /healthz` on the gateway (`200`) and `GET /` on web (`200`).
6. **Only on a fresh start**, does a full round trip: `POST
   /v1/auth/signup` through the real gateway → auth-svc → postgres path.
   `200`/`201` = fully proven; `429` = still proven reachable (rate
   limiter state is Redis-backed and outlives the process, so a `429`
   from a prior run's attempts is expected, not a failure — see
   Gotchas). Anything else fails loudly.

Skips the signup round trip when reusing an already-up stack — the
port + healthz checks already cover that case, and re-hammering signup
just burns down the shared rate limit for no new information.

## Credentials (match `.env.example`)

| Service | Detail |
|---|---|
| postgres | `postgresql://vidforge:vidforge@localhost:5432/vidforge` |
| redis | `redis://localhost:6379` |
| minio API | `http://localhost:9000` — key `vidforge` / secret `vidforge-secret` |
| minio console | `http://localhost:9001` (same creds) |
| mailpit | SMTP `localhost:1025`, web UI/API `http://localhost:8025` |

## Run (human path)

```bash
docker compose up -d          # from README — starts containers, no verification
```

Then eyeball `docker compose ps`. Doesn't check readiness or create
the bucket — use the agent path above for that.

## Gotchas

- **`docker compose up -d` returning "Running" doesn't mean ready.**
  Postgres in particular can report a running container before it's
  accepting connections; the script's `pg_isready` poll loop exists
  because of this.
- **The apps expect a bucket that doesn't exist by default.** MinIO
  starts empty — `S3_BUCKET=vidforge-media` from `.env.example` has to
  be created before any upload/playback flow will work. `mc mb -p` is
  idempotent so it's safe to run every time rather than checking first.
- **`docker compose down` (no `-v`) keeps volumes** — postgres data and
  minio objects persist across restarts. Use `-v` only if you
  deliberately want a wiped dev database, and confirm with the user
  first since it's destructive.
- **mailpit is opt-in** (`--with-mail`) — most dependency checks don't
  need it, and the base README's `docker compose up -d` already starts
  it since it has no profile gate, so don't assume its absence means
  it isn't running.
- **`turbo run dev` silently drops your `.env` vars — always pass
  `--env-mode=loose`.** Turborepo's default *strict* env mode only
  passes an env var into a task if it's declared in `turbo.json`'s
  `env`/`globalEnv` (this repo declares neither). Without the flag,
  `DATABASE_URL`, `REDIS_URL`, `S3_*`, etc. from `.env` all vanish —
  services either crash outright (auth-svc: `PrismaClientInitializationError:
  Environment variable not found: DATABASE_URL`) or silently degrade
  (api-gateway logs `no REDIS_URL — rate limits fall back to
  per-process counters` and keeps running, which is worse because
  nothing *looks* broken). `apps.sh` always passes the flag; if you
  ever launch `turbo dev` by hand, don't forget it. Sourcing `.env`
  into the shell first is still required too — `--env-mode=loose`
  only stops turbo from *stripping* vars that are already there.
- **`tsx watch` does not restart after a crash, only after a file
  save.** If a service dies (uncaught exception — the DB drift below
  is one way to trigger this), its port stays closed until you kill
  and re-run `turbo dev` entirely; touching the file doesn't help once
  the whole `turbo` process tree is gone. `apps.sh`'s port-based
  reuse check will correctly detect this as "not up" and start fresh.
- **`node_modules` can be partially linked without pnpm complaining.**
  A workspace package (e.g. `@vidforge/grpc-health`) can be missing
  its symlink in a consumer's `node_modules/@vidforge/` even when
  `pnpm install` reports "Already up to date" — seen after the lockfile
  was untouched but linking had gone stale. Symptom:
  `ERR_MODULE_NOT_FOUND` for an `@vidforge/*` package or an external
  dep (`ioredis`) that's clearly in `package.json`. Fix is just
  `pnpm install` again — it does the relinking even when it claims
  nothing changed. `apps.sh` runs this every time as a cheap safety net.
- **The auth rate limiter is Redis-backed, so it outlives `turbo dev`
  restarts.** Hammering `/v1/auth/signup` across several manual test
  runs trips it for the configured window (seen: ~500s), and a fresh
  `turbo dev` process doesn't reset it — the counter lives in redis,
  not in the process. A `429` on signup after repeated testing is
  expected, not a sign the stack is broken; `apps.sh` treats it as a
  soft-pass for exactly this reason.
- **`prisma migrate status` only checks the `_prisma_migrations`
  bookkeeping table, not the actual schema.** A migration can be
  recorded as applied (even successfully, `0` steps) while its DDL
  never ran — `migrate status` will happily say "Database schema is up
  to date!" while columns are missing. Only a real request that
  touches those columns surfaces it (as a `PrismaClientKnownRequestError:
  The column "X" does not exist` crash, not a schema-status failure).
  See Troubleshooting for the exact incident and fix.

## Troubleshooting

- `minio health check failed: HTTP 000` — minio container isn't up
  yet or port 9000 is taken by something else; check
  `docker compose ps` and `docker compose logs minio`.
- `pg_isready` never succeeds within 30s — check
  `docker compose logs postgres` for a crash (commonly a stale
  `pgdata` volume from an incompatible postgres version after an
  image bump).
- `PrismaClientInitializationError: Environment variable not found:
  DATABASE_URL` (or api-gateway logging `no REDIS_URL`) — `turbo dev`
  was run without `--env-mode=loose`, or `.env` wasn't sourced into
  the shell before launching. Kill everything and use `apps.sh`.
- `ERR_MODULE_NOT_FOUND` for `@vidforge/<package>` or a normal external
  dependency that's clearly declared in that app's `package.json` —
  stale/partial workspace linking. `pnpm install` (yes, even if it
  says "Already up to date") fixes it; then restart the crashed
  services (`tsx watch` won't self-heal — see Gotchas).
- **`PrismaClientKnownRequestError: The column "User.passwordHash"
  does not exist in the current database` (or any column from a
  migration that `prisma migrate status` insists is applied).** Hit
  once on this dev DB: `_prisma_migrations` had
  `20260612181558_user_auth_and_job_creator` recorded as applied with
  `applied_steps_count = 0` and `started_at == finished_at` — a sign
  it was baselined (`migrate resolve --applied`) rather than actually
  executed, so its `ALTER TABLE` statements never ran. Confirm with:
  ```bash
  docker compose exec -T postgres psql -U vidforge -d vidforge -c \
    'select migration_name, started_at, finished_at, applied_steps_count from "_prisma_migrations" order by started_at;'
  ```
  `prisma migrate resolve --rolled-back` only works on migrations
  recorded as *failed*, not on a wrongly-baselined success, so it
  can't undo this. The fix (do **not** `db push`, per project policy):
  verify the affected tables are empty (`select count(*) from "User"`
  etc. — don't do this against real data), then apply that migration's
  exact SQL directly:
  ```bash
  docker compose exec -T postgres psql -U vidforge -d vidforge -v ON_ERROR_STOP=1 \
    < packages/db/prisma/migrations/<name>/migration.sql
  ```
  This makes the schema match what the migration history already
  claims, without touching Prisma's bookkeeping or using `db push`.
  If the affected tables aren't empty, stop and ask the user — this
  approach only holds for a corrupted dev DB with no real data at
  stake.
