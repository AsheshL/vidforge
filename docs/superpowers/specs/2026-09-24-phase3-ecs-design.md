# Phase 3 (Services on ECS) — Design

Date: 2026-09-24
Status: approved, pending implementation plan

## Purpose

Implement Phase 3 of `docs/aws-deployment.md` — deploy the five real VidForge
apps onto the ECS Fargate cluster/networking Phase 2 already provisioned, so
the app actually runs on AWS for the first time. `metadata-svc` is excluded:
it has no Dockerfile and its `main.ts` is a stub with no service
implementation (`registerService` never called), matching its existing
absence from `docker-compose.prod.yml` and the deployment doc's service
table.

## Scope decisions

- **HTTP only, no domain yet.** No domain is registered anywhere in this
  repo. The ALB gets a single HTTP:80 listener on its own
  `*.elb.amazonaws.com` DNS name — no ACM cert, no Route53. HTTPS + a real
  domain is a fast, isolated follow-up once a domain exists; it doesn't
  block getting the stack running on ECS.
- **Single ALB, path-based routing** (a consequence of the above — host-based
  routing needs multiple hostnames, which a single default DNS name can't
  provide). `/v1/*` and `/healthz` → api-gateway target group; everything
  else (default) → web target group. Verified no collision: every
  api-gateway route lives under `/v1/*` (`apps/api-gateway/src/main.ts`).
  `NEXT_PUBLIC_GATEWAY_URL` is set to `""` at web's build time so its
  `fetch` calls become same-origin relative paths through the ALB — this
  avoids CORS entirely rather than configuring it.
- **Worker autoscaling is in scope**, on BullMQ queue depth via a
  self-published CloudWatch custom metric (see Components §6) — not deferred
  to a later phase.
- **Manual deploy for now.** This phase builds the ECR repos, ECS
  cluster/services/task defs, and does the first deploy by hand (build/push
  script + `terraform apply`). The GitHub Actions OIDC deploy pipeline
  described in the deployment doc's CI/CD section is a separate follow-up.
- **Git-SHA image tags.** Every push tags `<repo>:<full-git-sha>` (plus
  `:latest` for convenience only — task definitions always pin the SHA, never
  `:latest`). The build script refuses to run with uncommitted changes, so a
  tag always means exactly the commit it names.
- **Per-service IAM task roles**, not one shared role — least privilege per
  service (e.g. only the services that touch S3 get S3 permissions). A
  separate, shared **execution role** (distinct AWS concept — used by the
  ECS agent to pull images/inject secrets/write logs, not by app code) is
  fine to share across all task defs; it doesn't grant the running
  application anything.
- **Fixed task sizing to start** (`desiredCount: 1` per service, modest CPU/
  memory), matching Phase 2's cost-conscious sizing (`t4g.micro` etc.) —
  bump via tfvars once traffic is real. Only the worker autoscales
  (min 1, max 4).
- **S3 client code fix is in scope**, not deferred to infra workarounds. The
  current code in `apps/api-gateway/src/routes/{uploads,dev,playback}.ts`
  and `apps/video-svc/src/storage.ts` unconditionally passes explicit
  `credentials` (defaulting to MinIO's dev creds) and hardcodes
  `forcePathStyle: true`. Left as-is, the AWS SDK would never fall through
  to its default credential provider chain, so the ECS task's IAM role would
  never actually be used for S3 access — undermining the per-service
  task-role decision above and forcing long-lived IAM access keys into
  Secrets Manager instead. Fixed by making credentials/path-style/endpoint
  conditional on whether `S3_ACCESS_KEY` is set (see Components §3).

## Components

### 1. ECR

Five repositories (video-svc has two Docker targets — API and worker — each
a distinct image): `vidforge/web`, `vidforge/api-gateway`,
`vidforge/auth-svc`, `vidforge/video-svc-api`, `vidforge/video-svc-worker`.
`aws_ecr_repository` per image, image scanning on push enabled (free,
catches known CVEs in base images).

A build/push helper, `infra/scripts/build-and-push.sh` (default: all five;
optional single-app arg): `git diff --quiet` guard against uncommitted
changes, `aws ecr get-login-password | docker login`, then the same
`docker build -f apps/<app>/Dockerfile .` root-context build the README
already documents, tagged `:<full-git-sha>` and `:latest`, both pushed.

### 2. ECS cluster & networking

- `aws_ecs_cluster` (`vidforge-prod`), Fargate only (no EC2 capacity
  provider).
- Cloud Map private DNS namespace `vidforge.local`, linked to the Phase 2
  VPC. `auth-svc` registers as `auth.vidforge.local`, video-svc (API) as
  `video.vidforge.local`. The worker has no listener and does not register.
  The gateway's `AUTH_SVC_ADDR`/`VIDEO_SVC_ADDR` env vars point at these
  names — no code changes; the app already reads these as config
  (`README.md`: "service-discovery names in prod").
- All tasks run in the private subnets Phase 2 created, `awsvpc` network
  mode, no public IP. They reach ECR/CloudWatch/Secrets Manager over the
  NAT Phase 2 already provisioned, and S3 over the existing gateway
  endpoint.
- Reuses the existing `app` security group (Phase 2 output
  `app_security_group_id`) for every task, extended with two new
  `aws_security_group_rule` resources (not recreating the SG): ingress from
  the new ALB SG on 4000/3000 (gateway/web), and a self-referencing ingress
  rule on 50051/50053 for internal gRPC calls between tasks sharing the SG.
- One CloudWatch Logs group per service (`/ecs/vidforge-prod/<service>`,
  14-day retention), `awslogs` driver on every task def.
- Shared execution role: `ecr:GetDownloadUrlForLayer`/`BatchGetImage`/
  `GetAuthorizationToken`, `logs:CreateLogStream`/`PutLogEvents`, and
  `secretsmanager:GetSecretValue` scoped to exactly the four secret ARNs
  Phase 2 created.

### 3. S3 client fix (app code)

In each of the four files listed under Scope decisions, replace the
hardcoded MinIO-shaped config with:

```ts
const explicitCreds = process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
  ? { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY }
  : undefined; // unset in prod -> SDK default chain -> ECS task's IAM role

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT, // undefined in prod -> SDK resolves the real regional endpoint
  region: process.env.S3_REGION ?? "us-east-1",
  forcePathStyle: Boolean(explicitCreds), // only MinIO needs path-style
  credentials: explicitCreds,
});
```

Dev and `docker-compose.prod.yml` are unaffected — both already set
`S3_ACCESS_KEY`/`S3_ENDPOINT` explicitly. In ECS, none of those three env
vars are set, so the SDK auto-resolves the real endpoint and credentials
via the task role. `playback.ts`'s `s3Public` client gets the same
treatment (its own `S3_PUBLIC_ENDPOINT` fallback, same credential/path-style
logic).

### 4. Task definitions & services

One task definition + one `aws_ecs_service` per app (worker excepted — see
§6 for its autoscaling target). `desiredCount: 1` each. `stopTimeout` set
past each app's `SHUTDOWN_GRACE_MS` (25s default): 30s for
web/gateway/auth-svc/video-svc-api, 120s for the worker (in-flight
transcode needs room to finish or requeue).

| Service | CPU / Memory | Task role permissions | Secrets injected |
|---|---|---|---|
| web | 0.25 vCPU / 512 MB | none | none |
| api-gateway | 0.25 vCPU / 512 MB | S3 get/put/head/list on the media bucket | `context-signing-secret`, `database-url` |
| auth-svc | 0.25 vCPU / 512 MB | none | `jwt-secret`, `context-signing-secret`, `database-url`, `smtp-url` |
| video-svc (API) | 0.25 vCPU / 512 MB | S3 get/put/head/list on the media bucket | `context-signing-secret`, `database-url` |
| transcode-worker | 2 vCPU / 4 GB | S3 get/put/head/list on the media bucket, `cloudwatch:PutMetricData` (namespace-scoped, see §6) | `context-signing-secret`, `database-url` |

Health checks: every image except the worker already ships a Docker
`HEALTHCHECK` (gateway: `/healthz`; auth-svc/video-svc-api: gRPC
`Health/Check`) — Fargate uses these automatically, no `healthCheck` block
needed in the task def. Next.js has no equivalent, so `apps/web` gets a
trivial `GET /api/health` route (200, no body) added as part of this phase,
used both for its image `HEALTHCHECK` and the ALB target group.

### 5. ALB

Public subnets, one HTTP:80 listener, **120s idle timeout** (required for
the SSE job-progress stream, `/v1/jobs/:id/events`, per the deployment
doc). Two target groups (`web`, `api-gateway`); listener rules: `/v1/*` and
`/healthz` → api-gateway, default → web. `TRUST_PROXY=true` on the gateway
— safe because the app SG only admits port-4000 traffic from the ALB SG
(§2), matching the deployment doc's caveat exactly.
`RATE_LIMIT_REDIS_URL` set to the Phase 2 ElastiCache endpoint output.

### 6. Worker autoscaling

The worker publishes its own queue depth: a `setInterval` (every 30s) in
`apps/video-svc/src/worker-main.ts` calling the existing BullMQ `Queue`
object's `getWaiting()` and `PutMetricData`-ing the count to CloudWatch —
namespace `VidForge/Queue`, metric `WaitingJobs`, dimension
`QueueName=transcode`. No separate Lambda/cron; reuses infrastructure
already running (the worker itself, `desiredCount` never below 1).

`aws_appautoscaling_target` on the worker service's `DesiredCount`
(min 1, max 4). Two step-scaling policies via CloudWatch alarms on
`WaitingJobs`:
- Scale out: `WaitingJobs > 5` for 2 consecutive 1-min periods → +1 task.
- Scale in: `WaitingJobs == 0` for 5 consecutive 1-min periods → −1 task.

### 7. Migration task

One `aws_ecs_task_definition` with no matching service — reuses the
`api-gateway` image, command `pnpm --filter @vidforge/db db:deploy`,
exactly like `docker-compose.prod.yml`'s `migrate` service. Runs in the
private subnets **using the `app` security group** — RDS's security group
(Phase 2's `database.tf`) only allows ingress from `app`, so this is not
optional: any other SG (or none) can reach ECR/Secrets Manager fine but
can't reach postgres at all. Needs only the `database-url` secret. Run on
demand via `infra/scripts/run-migration.sh` (`aws ecs run-task` +
`aws ecs wait tasks-stopped` + exit-code check) before each deploy, per the
manual-deploy decision — not wired into any automated pipeline this phase.

### 8. Terraform file layout

New files in `infra/terraform/`, following Phase 2's existing pattern
(group by concern; a resource's security-group rules or IAM role live next
to it rather than in a separate catch-all file):

```
ecr.tf              5 repositories, image scanning on push
alb.tf               ALB, target groups, listener + path rules, ALB security group
ecs-cluster.tf        cluster, Cloud Map namespace, shared execution role, log groups
ecs-web.tf            web task def + service, /api/health route is an app-code change (§4)
ecs-gateway.tf         api-gateway task def + service, app-SG ingress rules from the ALB
ecs-auth.tf            auth-svc task def + service, Cloud Map registration
ecs-video.tf           video-svc-api + transcode-worker task defs + services, Cloud Map registration
ecs-autoscaling.tf     appautoscaling target/policies + CloudWatch alarms for the worker
ecs-migration.tf       one-off migration task definition
```

Plus new variables appended to the existing `variables.tf` (image tags per
service, task sizing overrides, autoscaling min/max) and new outputs
appended to `outputs.tf` (ALB DNS name, cluster name, ECR repo URLs, Cloud
Map namespace) — the same incremental growth pattern Phase 2 used task by
task.

## Validation before apply

`terraform fmt -check`, `terraform validate`, `terraform plan` reviewed by
the operator. **No `terraform apply` runs without explicit confirmation on
the plan output** — this phase creates real, billed AWS resources, on top
of what Phase 2 already created.

## Out of scope (explicitly)

- HTTPS, ACM certificate, Route53, any real domain.
- GitHub Actions OIDC deploy pipeline / auto-deploy-on-merge.
- `metadata-svc` (no implementation yet — stub only).
- CloudFront, mTLS/App Mesh, WAF (Phase 5).
- SES resource provisioning (already out of scope from Phase 2; still
  unaddressed — `smtp-url` secret is still the Phase 2 placeholder).
- Scaling `desiredCount` below 1 for any non-worker service, or above 1 for
  any service — single instance per non-worker service until real traffic
  justifies more.
