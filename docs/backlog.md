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

### ~~2. Re-run a job with a different rendition profile~~ Done

`SubmitTranscodeJob` already accepted an arbitrary profile; the dashboard just
hardcoded one (720p + 360p). `apps/web/lib/renditionPresets.ts` now defines a
small set of named presets (720p+360p, 1080p+720p+360p, 480p-only), surfaced
via a shared `RenditionPicker` dropdown (`apps/web/components/RenditionPicker.tsx`)
used in two places: the "Transcode" action in `AssetsBoard.tsx`, and a new
"Re-run" action on completed jobs in `JobsBoard.tsx`, both posting to the same
`/v1/assets/:assetId/transcode` endpoint. No backend change needed.

### ~~3. API keys~~ Done

`CreateApiKey` and `RevokeApiKey` are implemented in
`apps/auth-svc/src/service.ts`, alongside a new `ListApiKeys` RPC
(`packages/proto/src/auth.proto`) for the management UI. Issued keys are
`vfk_<keyId>_<random>` strings — the prefix lets `VerifyToken` tell a key from
a JWT without a database round trip, and the embedded key id turns lookup into
an indexed `findUnique` rather than a scan; the full string is then hashed
with the same scrypt scheme as passwords (`apps/auth-svc/src/password.ts`) and
compared with `verifyPassword`. `VerifyToken` honours `expiresAt`/`revokedAt`,
and a key's `RequestContext.userId` is its creator's id (a key has no user of
its own, but audit attribution and org-scoping need a real one). A key's role
cannot exceed its creator's role. Management UI lives in
`apps/web/components/ApiKeysPanel.tsx` (create, one-time secret reveal with
copy, list, revoke), rendered on the org settings page.

### ~~4. Standalone `GenerateThumbnails` RPC~~ Done

`GenerateThumbnails` in `apps/video-svc/src/service.ts` enqueues a
thumbnails-only job onto the same `TRANSCODE_QUEUE` / worker as
`SubmitTranscodeJob`: an empty `renditions` list on the job's `profileJson`
marks it thumbnails-only, so the worker skips rendition transcoding, leaves
the asset's playback state untouched, and just extracts JPEGs — evenly spaced
by `count` when set, otherwise every `interval_seconds` — at `width`, uploads
them under `processed/<jobId>/thumbs/`, and records the keys in
`manifestJson.thumbnailStorageKeys` exactly as the existing side-effect path
does.

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

### ~~6. jobs-svc~~ Done

`apps/jobs-svc` implements `JobQueueService` end to end: `GetQueueStats` and
`StreamQueueEvents` read BullMQ's own queue/event APIs (scoped to the caller's
org by correlating BullMQ job ids back to `TranscodeJob` rows, since BullMQ
itself has no org concept), `RegisterWebhook`/`ListWebhooks`/`DeleteWebhook`
are full CRUD against the existing `Webhook` model, and `GetUsage` aggregates
`transcode_minutes` and `jobs_completed` from completed `TranscodeJob` rows in
the requested window. `storage_bytes`/`egress_bytes` are returned as `0` —
neither is tracked anywhere in the schema today (`Asset.sourceBytes` is the
*source* upload's size, not a transcoded output's, and there is no egress
accounting at all), so this needs new tracking, not just a new RPC, before it
can report real numbers. This also completes the RPC-level half of item 8
below (registering/listing/deleting webhooks) — delivery/dispatch is still
open, see that item.

### ~~7. Asset list pagination~~ Done

`ListJobs` does real cursor pagination (ordered on `(submittedAt, id)`, last id
as the page token, true `totalCount`). The asset listing does not:
`apps/api-gateway/src/routes/assets.ts` takes a hardcoded `take: 100` with no
page token and no total. Fine at current scale, wrong past ~100 assets per org.

Done. `GET /v1/assets` now accepts `pageSize`/`pageToken` (same `[1, 100]`
clamp, default 50, as `/v1/jobs`), orders on `(createdAt, id)` desc, and
returns `pageInfo: { nextPageToken, totalCount }` via a Prisma `cursor`/`skip: 1`
query paired with `prisma.asset.count`. `AssetsBoard.tsx` grew the same
"N of total" / "Load more" UI `JobsBoard.tsx` already had for jobs.

### 8. Webhooks

The `Webhook` model exists (URL, signing secret, `events` name list, `active`)
and
`packages/queue` defines a `WEBHOOK_QUEUE` constant, but nothing enqueues,
dispatches, signs, or retries a delivery, and there is no UI to register one.

RPC-level management (`RegisterWebhook`/`ListWebhooks`/`DeleteWebhook` in
`apps/jobs-svc`) is done as part of item 6 above. Still open: the dispatch
half — enqueueing a `WebhookJobData` onto `WEBHOOK_QUEUE` when a matching
`QueueEvent` fires, a worker that signs and delivers it, retries, and a UI to
register one.

### 9. Collections

`Collection` and `CollectionAsset` models exist and are entirely unused — no
RPCs, no routes, no UI.

## Infrastructure hardening

**All AWS infra torn down 2026-09-25** (`terraform destroy` + force-deleted the
5 non-empty ECR repos out-of-band). Everything below describes what *was*
built, kept as a record for re-provisioning — none of it is currently
running. Survived the teardown: the `vidforge-prod-terraform-state` S3 bucket
(`prevent_destroy`) and the `vidforge.dev` Route53 registration (managed
out-of-band, never in Terraform). No RDS final snapshot was taken.

### In flight — Phase 3 (ECS services)

Merged to main (was branch `infra-phase3-ecs`, since deleted). Built there: ECR
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
  recipient addresses. Production access requested out-of-band via
  `aws sesv2 put-account-details` on 2026-09-25 (transactional mail type,
  `vidforge.dev`); `ReviewDetails.Status` is `PENDING` awaiting AWS review.

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

- ~~**Terraform remote state.**~~ Done. `infra/terraform/providers.tf` now has
  a `backend "s3"` block (`infra/terraform/state-backend.tf` for the bucket
  itself — versioned, AES256-encrypted, public access blocked). Uses
  Terraform 1.10+'s native S3 state locking (`use_lockfile = true`), so no
  DynamoDB table. The CI/CD pipeline above still talks to ECS directly
  rather than running `terraform apply`, though — that would be a separate
  follow-up now that state is actually reachable from CI.
- ~~**Secret rotation.**~~ Done. `verifyContext` (`packages/svc-auth/src/index.ts`)
  and `verifyJwt` (`apps/auth-svc/src/jwt.ts`) now accept a signature/token
  produced by either the current secret or an optional `*_PREVIOUS` one
  (`CONTEXT_SIGNING_SECRET_PREVIOUS`, `JWT_SECRET_PREVIOUS`); signing still
  only ever uses the current secret. `infra/terraform/secrets.tf` holds a
  `*-previous` Secrets Manager secret per rotated secret (starts empty,
  `ignore_changes` on `secret_string` so `apply` can't clobber a manual
  rotation), wired into every ECS task definition that consumes them
  (`ecs-auth.tf`, `ecs-gateway.tf`, `ecs-video.tf`). Manual rotation
  procedure documented in `infra/terraform/README-secret-rotation.md`.
- **Backups and DR.** RDS keeps 7 days of automated backups, but there is no
  documented restore procedure, no tested restore, and no
  lifecycle/replication policy on the media bucket.
