# Build from the repo root: docker build -f apps/web/Dockerfile \
#   --build-arg NEXT_PUBLIC_GATEWAY_URL=https://api.example.com .
FROM node:20-slim AS pruner
RUN npm install -g turbo@2
WORKDIR /repo
COPY . .
RUN turbo prune @vidforge/web --docker

FROM node:20-slim AS builder
RUN corepack enable
WORKDIR /app
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .

# Inlined into the client bundle at build time.
ARG NEXT_PUBLIC_GATEWAY_URL=http://localhost:4000
ENV NEXT_PUBLIC_GATEWAY_URL=$NEXT_PUBLIC_GATEWAY_URL
RUN pnpm --filter @vidforge/web build

FROM node:20-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]
