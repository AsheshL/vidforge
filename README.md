# VidForge

Enterprise video asset management & transcoding platform.

## Stack

- **gRPC + Protobuf** — inter-service contracts ([packages/proto](packages/proto))
- **fluent-ffmpeg** — transcoding workers ([apps/video-svc](apps/video-svc))
- **Prisma + PostgreSQL** — metadata store ([packages/db](packages/db))
- **BullMQ + Redis** — job queue ([packages/queue](packages/queue))
- **Next.js 15 + React 19 RSC + Tailwind** — dashboard ([apps/web](apps/web))
- **Fastify** — REST → gRPC gateway ([apps/api-gateway](apps/api-gateway))

## Getting started

```bash
pnpm install
docker compose up -d          # postgres, redis, minio
cp .env.example .env
pnpm proto:gen                # generate TS from .proto files
pnpm db:migrate               # create database schema
pnpm dev                      # run everything via turbo
```

## Production images

Each app ships a Dockerfile (built from the repo root via `turbo prune`);
video-svc has separate `api` and `worker` targets so only the worker image
carries ffmpeg. The full production-shaped stack — split worker, one-off
migration task, offset host ports so it coexists with the dev stack:

```bash
# -p isolates the prod stack from the dev stack — see note below.
docker compose -p vidforge-prod -f docker-compose.prod.yml up --build -d
# web http://localhost:3100, gateway http://localhost:4100
```

The AWS rollout plan lives in [docs/aws-deployment.md](docs/aws-deployment.md).

### Production notes

These are the things that differ from dev and will bite if missed:

- **Always pass `-p vidforge-prod`.** Both compose files default to the
  `video-fs` project name, so without `-p` the prod stack reuses the dev
  Postgres volume — whose schema was applied by `db push` with no migration
  history, making `migrate deploy` fail with `type "Role" already exists`.
- **Run migrations as a one-off task, never at container startup.** The prod
  compose does this via the `migrate` service (`pnpm db:deploy`), which the
  app services wait on (`depends_on: service_completed_successfully`). On AWS
  this is an ECS task run before the service update. The schema is
  migration-only now — never `prisma db push` against a real database (CI
  enforces this with `db:drift-check`).
- **Split the transcode worker from the video API.** The worker runs as its
  own service/image (the only one carrying ffmpeg) and is the autoscaling
  unit. Set `DISABLE_INLINE_WORKER=1` on the video-svc API so it doesn't also
  process jobs. Give the worker a long stop grace (`stop_grace_period: 120s`
  / ECS `stopTimeout`) so an in-flight transcode can drain on SIGTERM.
- **Internal vs. public S3 endpoints are different in prod.** `S3_ENDPOINT`
  is the in-network address the services use to read/write objects
  (`minio:9000`, or the S3 VPC endpoint). `S3_PUBLIC_ENDPOINT` is the
  browser-reachable host embedded in presigned playback URLs (the host port,
  or CloudFront). In dev they're identical; set both in prod or HLS playback
  breaks.
- **Put the gateway behind a proxy correctly.** Set `WEB_ORIGIN` for CORS,
  and give the load balancer an idle timeout ≥ 120s so SSE job-progress
  streams (`/v1/jobs/:id/events`) aren't cut off. Behind a load balancer the
  gateway also needs Fastify `trustProxy` enabled so rate limiting keys off
  the real client IP rather than the proxy's — a tracked Phase 4 change (see
  [docs/aws-deployment.md](docs/aws-deployment.md)).
- **Secrets are env-injected.** `JWT_SECRET`, `CONTEXT_SIGNING_SECRET`,
  `DATABASE_URL`, and the SMTP/S3 credentials come from the environment
  (Secrets Manager on AWS), never from a committed `.env`. The
  `CONTEXT_SIGNING_SECRET` must match across the gateway and the internal
  services or signed-context verification fails.
- **Inter-service addresses are config.** The gateway dials `AUTH_SVC_ADDR`
  and `VIDEO_SVC_ADDR` (service-discovery names in prod), defaulting to
  `localhost` for dev.

## Layout

```
apps/
  web/           Next.js 15 dashboard
  api-gateway/   REST -> gRPC fan-out (Fastify, port 4000)
  video-svc/     gRPC :50051 — transcoding (fluent-ffmpeg)
  metadata-svc/  gRPC :50052 — asset catalog (Prisma)
  auth-svc/      gRPC :50053 — JWT, RBAC, audit log
packages/
  proto/         .proto sources + ts-proto generated types
  db/            Prisma schema + shared client
  queue/         BullMQ queue/worker factories
```

## Proto workflow

Edit `.proto` files in `packages/proto/src/`, then run `pnpm proto:gen`.
Generated TypeScript lands in `packages/proto/gen/` (gitignored) and is
imported everywhere as `@vidforge/proto`.
