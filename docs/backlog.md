# Backlog

What is deliberately not built yet, and what remains to harden the deployment.
Phase numbers refer to [aws-deployment.md](aws-deployment.md). Completed items
are removed from this file once they land — see git history for their notes.

The product feature set was frozen on 2026-06-12 to focus on deployment. The
items under "Product features" are deferred by choice, not forgotten — each one
records what already exists so the work can be picked up without re-deriving it.

## Product features (deferred)

### 1. Thumbnails in the UI

The pipeline already generates them: a profile with `generateThumbnails` makes
the worker extract JPEGs at `thumbnailIntervalSeconds`, and the standalone
`GenerateThumbnails` RPC (`apps/video-svc/src/service.ts`) enqueues a
thumbnails-only job. Either way the JPEGs are uploaded under
`processed/<jobId>/thumbs/` and the keys recorded in the job's `manifestJson`
(`thumbnailStorageKeys`). `GetOutputManifest` returns them. Nothing in
`apps/web` references a thumbnail — the assets table and player page show none.

Remaining: serve the keys through the existing presigned-URL path (the same
mechanism `apps/api-gateway/src/routes/playback.ts` uses for segments) and
render them as asset posters / a scrubbing strip.

### 2. metadata-svc

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

### 3. Webhook delivery

The `Webhook` model exists (URL, signing secret, `events` name list, `active`),
`packages/queue` defines a `WEBHOOK_QUEUE` constant, and `apps/jobs-svc`
implements `RegisterWebhook`/`ListWebhooks`/`DeleteWebhook`.

Remaining: the dispatch half — enqueueing a `WebhookJobData` onto
`WEBHOOK_QUEUE` when a matching `QueueEvent` fires, a worker that signs and
delivers it, retries, and a UI to register one.

### 4. Storage and egress usage

`GetUsage` in `apps/jobs-svc` reports `transcode_minutes` and `jobs_completed`,
but returns `storage_bytes`/`egress_bytes` as `0` — neither is tracked anywhere
in the schema (`Asset.sourceBytes` is the *source* upload's size, not a
transcoded output's, and there is no egress accounting at all). This needs new
tracking, not just a new RPC.

### 5. Collections

`Collection` and `CollectionAsset` models exist and are entirely unused — no
RPCs, no routes, no UI.

## Infrastructure hardening

**All AWS infra torn down 2026-09-25** (`terraform destroy` + force-deleted the
5 non-empty ECR repos out-of-band). None of it is currently running; the
Terraform in `infra/terraform` is the record for re-provisioning. Survived the
teardown: the `vidforge-prod-terraform-state` S3 bucket (`prevent_destroy`)
and the `vidforge.dev` Route53 registration (managed out-of-band, never in
Terraform). No RDS final snapshot was taken.

### SES production access

This AWS account's SES is in sandbox mode (`ProductionAccessEnabled: false`) —
sending only reaches verified recipient addresses. Production access requested
out-of-band via `aws sesv2 put-account-details` on 2026-09-25 (transactional
mail type, `vidforge.dev`); `ReviewDetails.Status` is `PENDING` awaiting AWS
review. Raise `MAIL_RATE_LIMIT` once it is granted.

### Phase 5 (edge and post-launch hardening)

- **mTLS or App Mesh** between the gateway and the internal gRPC services.
  Context signing already prevents a forged `RequestContext`
  (`packages/svc-auth`), but the channels themselves are plaintext, so this is
  about transport privacy rather than authenticity.
- **WAF** on the ALB. Rate-based rules complement the application-level limits
  rather than replacing them (the app limiter is per-identity and knows about
  auth endpoints; WAF is per-IP and sits in front).

### Operational

- **Backups and DR.** RDS keeps 7 days of automated backups, but there is no
  documented restore procedure, no tested restore, and no
  lifecycle/replication policy on the media bucket.
- **Deploy through Terraform (optional).** Remote state now lives in S3, but
  the CI deploy job still updates ECS directly
  (`infra/scripts/ecs-register-revision.sh`) rather than running
  `terraform apply`, and each `aws_ecs_service` ignores `task_definition`
  changes so a workstation `apply` doesn't undo a CI deploy. Moving CI onto
  Terraform would drop that split.
