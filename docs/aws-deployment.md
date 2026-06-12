# AWS Deployment Plan

Target architecture for taking VidForge from docker-compose to AWS. Phases are
ordered so each one is independently shippable.

## Service mapping

| Local (docker-compose) | AWS |
|---|---|
| postgres:16 | RDS PostgreSQL 16 (Multi-AZ for prod) |
| redis:7 | ElastiCache for Redis |
| MinIO | S3 (one bucket, same `uploads/`, `tus-*`, `processed/` key layout) |
| Mailpit | SES (SMTP interface — `SMTP_URL` already drives nodemailer) |
| api-gateway (:4000) | ECS Fargate service behind an ALB |
| auth-svc (:50053) | ECS Fargate service (internal) |
| video-svc API (:50051) | ECS Fargate service (internal) |
| video-svc worker | Separate ECS service (same image, worker entrypoint), autoscaled on queue depth |
| web (Next.js) | ECS Fargate behind the ALB (or Vercel/Amplify if preferred) |

## Phase 1 — Containerize

- One multi-stage Dockerfile per app (`apps/*/Dockerfile`), built from the
  monorepo root with `pnpm fetch` + `turbo prune` for small contexts.
- Split video-svc into two entrypoints: `main.ts` (gRPC API, no ffmpeg) and a
  `worker.ts` entrypoint. The worker image installs ffmpeg (e.g.
  `jrottenberg/ffmpeg`-style static build); the API image doesn't need it.
- Run migrations via a one-off task (`pnpm db:deploy`), never at container
  startup. Wire it as an ECS task invoked by the deploy pipeline before the
  service update.
- Verify the whole stack with a `docker-compose.prod.yml` locally before
  touching AWS.

## Phase 2 — Core infrastructure (IaC)

Use CDK or Terraform from the start; nothing hand-created in the console.

- VPC: public subnets (ALB only), private subnets (ECS, RDS, ElastiCache),
  S3/SES via gateway/interface endpoints so transcoding traffic skips the NAT.
- RDS PostgreSQL 16: `db.t4g.medium` to start, Multi-AZ, automated backups,
  credentials in Secrets Manager.
- ElastiCache Redis: single node to start; BullMQ needs
  `maxRetriesPerRequest: null` (already set) and no cluster mode.
- S3 bucket: private, SSE-S3, lifecycle rule expiring incomplete multipart
  uploads after 7 days (covers abandoned tus uploads), CORS for the web origin
  (PUT/PATCH for tus, GET for presigned segment playback).
- Secrets Manager: `JWT_SECRET`, `CONTEXT_SIGNING_SECRET`, `DATABASE_URL`,
  SES SMTP credentials. Injected into tasks via ECS secrets, not env files.

## Phase 3 — Services on ECS

- Cluster with one Fargate service per app. Internal services (auth-svc,
  video-svc) get Cloud Map service discovery names; the gateway dials
  `auth.vidforge.local:50053` etc. instead of localhost.
- ALB: HTTPS (ACM cert), host- or path-routing to web and gateway.
  - The ALB must pass through tus headers (it does by default) and the
    gateway needs `trustProxy: true` so rate limiting sees real client IPs.
  - SSE (`/v1/jobs/:id/events`) requires ALB idle timeout ≥ the SSE session
    length expectation (set 120s+; the dashboard reconnects anyway).
- Worker service: CPU-heavy task size (2 vCPU / 4 GB to start). Autoscale on
  a CloudWatch metric published from BullMQ queue depth (small cron task or
  the worker itself publishing `getWaiting()` counts). Scale to zero off-hours
  if cost matters.
- Presigned URLs: set `S3_PUBLIC_ENDPOINT` to the real S3 endpoint (or
  CloudFront, phase 5). `forcePathStyle` must be off for real S3.

## Phase 4 — Production posture changes (code)

Small code changes this plan surfaces, all flagged in the codebase already:

1. Rate-limit store → Redis (`@fastify/rate-limit` Redis store) + `trustProxy`,
   so limits hold across gateway replicas.
2. SES: real `SMTP_URL`; invite emails get a real from-domain (SES domain
   verification + DKIM).
3. Health checks: gateway `/healthz` exists; add gRPC health checks (or TCP)
   for auth-svc/video-svc task definitions.
4. Graceful shutdown: SIGTERM handlers — worker `worker.close()` (waits for the
   in-flight ffmpeg or hands the job back), gateway `app.close()`. ECS gives
   30s by default; bump `stopTimeout` to 120s for the worker so a mid-flight
   transcode can finish or be requeued.

## Phase 5 — Edge and hardening (post-launch)

- CloudFront in front of presigned S3 segment URLs (signed cookies or keep
  presigning, origin = S3). Cuts playback latency and S3 request costs.
- mTLS or App Mesh between gateway and internal gRPC services (context
  signing already prevents forgery; this adds transport privacy).
- OpenTelemetry → ADOT collector sidecar → X-Ray/CloudWatch (trace_id is
  already plumbed through RequestContext).
- WAF on the ALB (rate-based rules complement the app-level limits).

## CI/CD

Extend `.github/workflows/ci.yml` with a deploy job on main (after the
existing lint/typecheck/test/drift-check gates):

1. Build images, push to ECR (tag = git SHA).
2. Run the migration task (`pnpm db:deploy`) against RDS; abort on failure.
3. `aws ecs update-service --force-new-deployment` per service (or CDK/
   Terraform apply), gated on circuit-breaker rollback.

GitHub OIDC → IAM role for the workflow; no long-lived AWS keys in repo
secrets.

## Rough monthly cost (low traffic)

| Item | Est. |
|---|---|
| RDS t4g.medium Multi-AZ | ~$110 |
| ElastiCache t4g.micro | ~$12 |
| Fargate (4 services + worker, modest sizing) | ~$80–150 |
| ALB | ~$20 |
| S3 + data transfer | usage-based, small |
| **Total** | **~$220–300/mo** (halve it with single-AZ RDS + scale-to-zero worker for staging) |
