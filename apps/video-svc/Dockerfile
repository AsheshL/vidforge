# Build from the repo root. Two targets share the build stages:
#   docker build -f apps/video-svc/Dockerfile --target api .     (gRPC API, no ffmpeg)
#   docker build -f apps/video-svc/Dockerfile --target worker .  (transcode worker, ffmpeg)
FROM node:20-slim AS pruner
RUN npm install -g turbo@2
WORKDIR /repo
COPY . .
RUN turbo prune @vidforge/video-svc --docker

FROM node:20-slim AS base
# openssl is required by the Prisma engine on slim images.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /repo/out/full/ .
RUN pnpm --filter @vidforge/proto proto:gen \
    && pnpm --filter @vidforge/db db:generate

ENV NODE_ENV=production
WORKDIR /app/apps/video-svc

FROM base AS api
ENV DISABLE_INLINE_WORKER=1
EXPOSE 50051
# Calls grpc.health.v1.Health/Check on itself. ECS reuses this when the task
# definition sets no healthCheck of its own. The worker target has no gRPC
# server to probe, so it gets none.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["./node_modules/.bin/tsx", "src/healthcheck.ts"]
# Run tsx directly rather than through `pnpm exec`: pnpm does not forward
# SIGTERM to the child, so the shutdown handlers would never run and the
# platform would SIGKILL the process at the end of its grace period.
CMD ["./node_modules/.bin/tsx", "src/main.ts"]

FROM base AS worker
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
# Direct tsx, not `pnpm exec` — see the api target above. The worker needs
# the signal most: SIGTERM is what lets it finish an in-flight transcode.
CMD ["./node_modules/.bin/tsx", "src/worker-main.ts"]
