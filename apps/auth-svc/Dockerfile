# Build from the repo root: docker build -f apps/auth-svc/Dockerfile .
FROM node:20-slim AS pruner
RUN npm install -g turbo@2
WORKDIR /repo
COPY . .
RUN turbo prune @vidforge/auth-svc --docker

FROM node:20-slim AS runner
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
WORKDIR /app/apps/auth-svc
EXPOSE 50053
# Calls grpc.health.v1.Health/Check on itself. ECS reuses this when the task
# definition sets no healthCheck of its own.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["./node_modules/.bin/tsx", "src/healthcheck.ts"]
# Run tsx directly rather than through `pnpm exec`: pnpm does not forward
# SIGTERM to the child, so the shutdown handlers would never run and the
# platform would SIGKILL the process at the end of its grace period.
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
