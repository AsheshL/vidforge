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
docker compose -f docker-compose.prod.yml up --build -d
# web http://localhost:3100, gateway http://localhost:4100
```

The AWS rollout plan lives in [docs/aws-deployment.md](docs/aws-deployment.md).

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
