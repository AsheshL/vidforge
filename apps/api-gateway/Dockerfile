# Build from the repo root: docker build -f apps/api-gateway/Dockerfile .
FROM node:20-slim AS pruner
RUN npm install -g turbo@2
WORKDIR /repo
COPY . .
RUN turbo prune @vidforge/api-gateway --docker

FROM node:20-slim AS runner
# openssl is required by the Prisma engine on slim images.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# Lockfile-only layer so dependency install caches across source changes.
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /repo/out/full/ .
RUN pnpm --filter @vidforge/proto proto:gen \
    && pnpm --filter @vidforge/db db:generate

ENV NODE_ENV=production
WORKDIR /app/apps/api-gateway
EXPOSE 4000
# /healthz turns 503 while the gateway drains, so this also reports the task
# as unhealthy during shutdown. Uses node's built-in fetch — no curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Run tsx directly rather than through `pnpm exec`: pnpm does not forward
# SIGTERM to the child, so the shutdown handlers would never run and the
# platform would SIGKILL the process at the end of its grace period.
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
