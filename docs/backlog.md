# Backlog

What is deliberately not built yet, and what remains to harden the deployment.
Phase numbers refer to [aws-deployment.md](aws-deployment.md).

The product feature set was frozen on 2026-06-12 to focus on deployment. The
items under "Product features" are deferred by choice, not forgotten — each one
records what already exists so the work can be picked up without re-deriving it.

## Product features (deferred)

### 1. Thumbnails in the UI

The pipeline already generates them: a profile with `generateThumbnails` makes
the worker extract JPEGs at `thumbnailIntervalSeconds`, upload them under
`processed/<jobId>/thumbs/`, and record the keys in the job's `manifestJson`
(`thumbnailStorageKeys`). `GetOutputManifest` returns them. Nothing in
`apps/web` references a thumbnail — the assets table and player page show none.

Remaining: serve the keys through the existing presigned-URL path (the same
mechanism `apps/api-gateway/src/routes/playback.ts` uses for segments) and
render them as asset posters / a scrubbing strip.

### 2. Re-run a job with a different rendition profile

`SubmitTranscodeJob` accepts an arbitrary profile, but the dashboard hardcodes
one: 720p + 360p, in `apps/web/components/AssetsBoard.tsx`. There is no way to
re-transcode an asset at different settings from the UI.

Remaining: a rendition picker on the transcode action, and a "re-run" entry
point from a finished job. No backend change needed.

### 3. API keys

`CreateApiKey` and `RevokeApiKey` are `UNIMPLEMENTED` stubs in
`apps/auth-svc/src/service.ts`. The `ApiKey` model already exists in the schema
with everything needed — `secretHash`, `role`, `orgId`, `createdBy`,
`expiresAt`, `revokedAt` — but nothing issues, stores, or accepts one, and
`VerifyToken` only understands JWTs.

Remaining: generate a key with a displayed-once secret, hash it the way
passwords are hashed (`apps/auth-svc/src/password.ts`), teach `VerifyToken` to
accept a key in place of a JWT (honouring `expiresAt`/`revokedAt`), and add
management UI. This is what unblocks server-to-server and CI callers.

### 4. Standalone `GenerateThumbnails` RPC

`UNIMPLEMENTED` in `apps/video-svc/src/service.ts`. Thumbnails can only be
produced as a side effect of a transcode today; there is no way to (re)generate
them for an existing asset without re-running the whole job.

### 5. metadata-svc

`apps/metadata-svc/src/main.ts` binds a gRPC server and registers no service —
`packages/proto/src/metadata.proto` is written but unimplemented. As a result
the gateway reads asset rows straight from Postgres in
`apps/api-gateway/src/routes/assets.ts`, which carries a comment saying it moves
behind metadata-svc when that service lands.

Remaining: implement the service (ffprobe-derived metadata on upload —
resolution, codec, duration before transcoding — plus the asset catalog reads),
then point the gateway at it. Note the ECS/Terraform work does not provision
metadata-svc; adding it means a task definition, service, Cloud Map entry, and
ECR repository.

### 6. jobs-svc

`packages/proto/src/jobs.proto` exists; there is no `apps/jobs-svc`. Intended
for scheduled/recurring job orchestration. Lowest priority of the unbuilt
services.

### 7. Asset list pagination

`ListJobs` does real cursor pagination (ordered on `(submittedAt, id)`, last id
as the page token, true `totalCount`). The asset listing does not:
`apps/api-gateway/src/routes/assets.ts` takes a hardcoded `take: 100` with no
page token and no total. Fine at current scale, wrong past ~100 assets per org.

### 8. Webhooks

The `Webhook` model exists (URL, signing secret, `events` name list, `active`)
and
`packages/queue` defines a `WEBHOOK_QUEUE` constant, but nothing enqueues,
dispatches, signs, or retries a delivery, and there is no UI to register one.

### 9. Collections

`Collection` and `CollectionAsset` models exist and are entirely unused — no
RPCs, no routes, no UI.

## Infrastructure hardening

### In flight — Phase 3 (ECS services)

On branch `infra-phase3-ecs`, **not yet merged to main**. Built there: ECR
repositories, ECS cluster with a Cloud Map private DNS namespace, task
definitions and services for web / api-gateway / auth-svc / video-svc API /
transcode-worker, the ALB with path-based routing, the one-off migration task,
and worker autoscaling driven by a queue-depth metric the worker publishes
itself (`apps/video-svc/src/worker-main.ts` → CloudWatch `VidForge/Queue`).

Remaining inside Phase 3:

- ~~**HTTPS.**~~ Done. `vidforge.dev` registered via Route53 (registration
  itself run out-of-band, not in Terraform — a purchased domain shouldn't be
  destroyable by `terraform destroy`); ACM cert, 443 listener, HTTP→HTTPS
  redirect, and the apex alias record are in `infra/terraform/https.tf`.
- ~~**`MAIL_FROM` and SES domain verification.**~~ Done. `vidforge.dev`
  verified as an SES domain identity, DKIM enabled, custom MAIL FROM domain
  set (`infra/terraform/ses.tf`); SMTP credentials generated out-of-band by
  `infra/scripts/generate-ses-smtp-credentials.sh` and written to Secrets
  Manager. **Still open:** this AWS account's SES is in sandbox mode
  (`ProductionAccessEnabled: false`) — sending only reaches verified
  recipient addresses until someone requests production access through AWS
  Support.

### Pending — Phase 5 (edge and post-launch hardening)

- **CloudFront** in front of the presigned S3 segment URLs (origin = S3, either
  signed cookies or continued presigning). Cuts playback latency and S3 request
  cost. `S3_PUBLIC_ENDPOINT` already exists as the seam to point at it.
- **mTLS or App Mesh** between the gateway and the internal gRPC services.
  Context signing already prevents a forged `RequestContext`
  (`packages/svc-auth`), but the channels themselves are plaintext, so this is
  about transport privacy rather than authenticity.
- **OpenTelemetry** → ADOT collector sidecar → X-Ray/CloudWatch. `trace_id` is
  already plumbed end to end through `RequestContext`; nothing emits spans.
- **WAF** on the ALB. Rate-based rules complement the application-level limits
  rather than replacing them (the app limiter is per-identity and knows about
  auth endpoints; WAF is per-IP and sits in front).

### ~~Pending~~ Done — CI/CD

A `deploy` job on `.github/workflows/ci.yml`, gated on the existing
lint/typecheck/test/drift-check job, runs on every push to main: builds and
pushes all 5 images tagged with the git SHA
(`infra/scripts/build-and-push.sh`), runs the migration
(`infra/scripts/ecs-ci-deploy.sh`, aborting the deploy on failure), then
deploys every service and verifies none of them hit a circuit-breaker
rollback (`deployment_circuit_breaker` is now on all 5 `aws_ecs_service`
resources).

Authenticates via GitHub OIDC → a repo/branch-scoped IAM role
(`infra/terraform/ci-cd.tf`) — no long-lived AWS keys in repository secrets.

Deliberately doesn't use Terraform to deploy (`aws ecs update-service`
directly instead, via `infra/scripts/ecs-register-revision.sh`): state is
still local-only (see "Terraform remote state" below), so CI has no way to
read or apply it. Each service's `aws_ecs_service` has
`lifecycle.ignore_changes` on `task_definition` so a later workstation
`apply` doesn't undo a CI deploy.

Live-tested end to end before landing (not just planned/reviewed): a full
run of `ecs-ci-deploy.sh` against real AWS — migration, all 5 services
redeployed, rollback check — completed clean.

### Pending — operational

- **Terraform remote state.** State is local
  (`infra/terraform/providers.tf` declares no backend; the `.tfstate` files are
  gitignored and live on one machine). That means no locking, no history, and
  the infrastructure is unmanageable from CI or a second operator — it should
  move to an S3 backend with DynamoDB state locking before anyone else touches
  it, and certainly before CI runs an apply.
- **Secret rotation.** `JWT_SECRET` and `CONTEXT_SIGNING_SECRET` are generated
  once by Terraform into Secrets Manager with no rotation path. Rotating
  `CONTEXT_SIGNING_SECRET` in particular needs thought: every service must
  accept both the old and new secret during the rollout window, which the
  verifier does not currently support.
- **Backups and DR.** RDS keeps 7 days of automated backups, but there is no
  documented restore procedure, no tested restore, and no
  lifecycle/replication policy on the media bucket.
