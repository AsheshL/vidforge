# Phase 3 (Services on ECS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the five real VidForge apps (web, api-gateway, auth-svc, video-svc API, transcode-worker) onto the ECS Fargate cluster/networking Phase 2 provisioned, so the app runs on AWS for the first time.

**Architecture:** New `.tf` files added to the existing `infra/terraform/` root config (same state as Phase 2 — resources reference Phase 2's directly by address, e.g. `aws_security_group.app.id`, no remote state needed). One ECS Fargate service per app behind a single HTTP ALB with path-based routing (`/v1/*` + `/healthz` → gateway, default → web). Internal services register with Cloud Map (`auth.vidforge.local`, `video.vidforge.local`). Two small app-code changes are prerequisites: a conditional S3-client fix (so the ECS task's IAM role actually gets used) and a trivial web health-check route (for the ALB target group).

**Tech Stack:** Terraform >= 1.9, `hashicorp/aws` ~> 5.0 (unchanged from Phase 2). TypeScript/vitest for the two app-code tasks. Bash for the two operational scripts.

**Spec:** `docs/superpowers/specs/2026-09-24-phase3-ecs-design.md`

## Global Constraints

- Region: `ap-south-1`, same Terraform state as Phase 2 (`infra/terraform/`, local, gitignored).
- HTTP only — no ACM cert, no Route53, no domain. ALB's own `*.elb.amazonaws.com` DNS name.
- `desiredCount: 1` for every service except the worker, which autoscales (min 1, max 4) on a self-published CloudWatch custom metric (`VidForge/Queue` namespace, `WaitingJobs` metric, `QueueName=transcode` dimension).
- Per-service IAM task roles (least privilege); one shared execution role across all task defs (ECS-agent-only concern — image pull, log write, secret injection — never granted to app code).
- Every image tag is the full git SHA of the commit it was built from — task definitions never reference `:latest`.
- `metadata-svc` is excluded (no Dockerfile, stub implementation) — not part of this plan.
- **No `terraform apply` runs without the operator reviewing the plan output and explicitly confirming.** Hard stop in the final task, same as Phase 2.
- Manual deploy only — no GitHub Actions/OIDC pipeline this phase.
- All new resources inherit the provider's `default_tags` (`Project=vidforge`, `Environment=prod`, `ManagedBy=terraform`) already configured in `providers.tf`.

---

## File Structure

```
apps/api-gateway/src/
  s3-config.ts                 # new — shared S3Client config resolver
  s3-config.test.ts             # new
  routes/uploads.ts             # modified — use resolveS3Config()
  routes/playback.ts            # modified — use resolveS3Config()
  routes/dev.ts                 # modified — use resolveS3Config()
apps/video-svc/
  package.json                  # modified — add vitest devDep + test script
  src/s3-config.ts               # new — same resolver, separate package
  src/s3-config.test.ts          # new
  src/storage.ts                 # modified — use resolveS3Config()
  src/worker-main.ts              # modified — publish queue-depth metric
apps/web/
  app/api/health/route.ts        # new — trivial 200 for the ALB target group
infra/terraform/
  variables.tf                   # modified — Phase 3 variables appended
  outputs.tf                     # modified — Phase 3 outputs appended
  ecr.tf                          # new — 5 repositories
  ecs-cluster.tf                  # new — cluster, Cloud Map ns, execution role, log groups
  alb.tf                          # new — ALB, target groups, listener + rules
  ecs-web.tf                      # new — web task def + service
  ecs-gateway.tf                   # new — api-gateway task def + service
  ecs-auth.tf                      # new — auth-svc task def + service
  ecs-video.tf                     # new — video-svc-api + transcode-worker task defs + services
  ecs-autoscaling.tf                # new — worker appautoscaling + alarms
  ecs-migration.tf                  # new — one-off migration task definition
infra/scripts/
  build-and-push.sh               # new — build/tag/push all 5 images
  run-migration.sh                # new — run the migration task, wait, check exit code
```

---

### Task 1: S3 client fix (api-gateway + video-svc)

**Files:**
- Create: `apps/api-gateway/src/s3-config.ts`
- Create: `apps/api-gateway/src/s3-config.test.ts`
- Modify: `apps/api-gateway/src/routes/uploads.ts`
- Modify: `apps/api-gateway/src/routes/playback.ts`
- Modify: `apps/api-gateway/src/routes/dev.ts`
- Create: `apps/video-svc/src/s3-config.ts`
- Create: `apps/video-svc/src/s3-config.test.ts`
- Modify: `apps/video-svc/src/storage.ts`
- Modify: `apps/video-svc/package.json`

**Interfaces:**
- Produces: `resolveS3Config(endpoint?: string): S3ClientConfig` in both `apps/api-gateway/src/s3-config.ts` and `apps/video-svc/src/s3-config.ts` (duplicated, not shared — different packages, no existing shared package for this). Consumed by the four modified route/storage files in this task, and referenced by Task 8/Task 10's IAM task-role design (the AWS SDK's default credential chain only kicks in because `credentials` comes back `undefined`).

- [ ] **Step 1: Write the failing test for api-gateway's resolver**

```typescript
// apps/api-gateway/src/s3-config.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { resolveS3Config } from "./s3-config.js";

const ENV_KEYS = ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_ENDPOINT", "S3_REGION"] as const;
const saved: Record<string, string | undefined> = {};

function clearEnv() {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("resolveS3Config", () => {
  it("uses explicit MinIO-shaped credentials and path-style when S3_ACCESS_KEY is set", () => {
    clearEnv();
    process.env.S3_ACCESS_KEY = "vidforge";
    process.env.S3_SECRET_KEY = "vidforge-secret";
    process.env.S3_ENDPOINT = "http://localhost:9000";

    const config = resolveS3Config(process.env.S3_ENDPOINT);

    expect(config.credentials).toEqual({ accessKeyId: "vidforge", secretAccessKey: "vidforge-secret" });
    expect(config.forcePathStyle).toBe(true);
    expect(config.endpoint).toBe("http://localhost:9000");
  });

  it("falls through to the SDK default credential chain when unset (prod/ECS shape)", () => {
    clearEnv();

    const config = resolveS3Config(process.env.S3_ENDPOINT);

    expect(config.credentials).toBeUndefined();
    expect(config.forcePathStyle).toBe(false);
    expect(config.endpoint).toBeUndefined();
  });

  it("defaults region to us-east-1 when S3_REGION is unset", () => {
    clearEnv();
    expect(resolveS3Config().region).toBe("us-east-1");
  });

  it("honors an explicit endpoint override (playback.ts's public client)", () => {
    clearEnv();
    process.env.S3_ACCESS_KEY = "vidforge";
    process.env.S3_SECRET_KEY = "vidforge-secret";

    const config = resolveS3Config("http://public-endpoint:9000");

    expect(config.endpoint).toBe("http://public-endpoint:9000");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @vidforge/api-gateway test -- s3-config`
Expected: FAIL — `Cannot find module './s3-config.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/api-gateway/src/s3-config.ts
import type { S3ClientConfig } from "@aws-sdk/client-s3";

// MinIO-shaped config when S3_ACCESS_KEY/S3_SECRET_KEY are set (dev,
// docker-compose): explicit credentials, forced path-style, whatever
// endpoint is configured. Unset in prod (ECS): credentials/endpoint come
// back undefined, so the SDK falls through to its default provider chain
// (the ECS task's IAM role) and resolves the real regional S3 endpoint —
// forcePathStyle must be off for that to work against real S3.
export function resolveS3Config(endpoint = process.env.S3_ENDPOINT): S3ClientConfig {
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;
  const explicitCreds = accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;

  return {
    endpoint,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: Boolean(explicitCreds),
    credentials: explicitCreds,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @vidforge/api-gateway test -- s3-config`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire `resolveS3Config` into `uploads.ts`**

Replace this block in `apps/api-gateway/src/routes/uploads.ts`:

```typescript
const s3Config = {
  region: process.env.S3_REGION ?? "us-east-1",
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  forcePathStyle: true, // required for MinIO
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "vidforge",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "vidforge-secret",
  },
};

const s3 = new S3Client(s3Config);
```

with:

```typescript
import { resolveS3Config } from "../s3-config.js";

const s3Config = resolveS3Config();
const s3 = new S3Client(s3Config);
```

(Add the `resolveS3Config` import alongside the existing imports at the top of the file; the rest of `uploads.ts` — `S3Store({ s3ClientConfig: { bucket: BUCKET, ...s3Config } })` — is unchanged, since `s3Config` still has the same shape.)

- [ ] **Step 6: Wire `resolveS3Config` into `playback.ts`**

Replace this block in `apps/api-gateway/src/routes/playback.ts`:

```typescript
const credentials = {
  accessKeyId: process.env.S3_ACCESS_KEY ?? "vidforge",
  secretAccessKey: process.env.S3_SECRET_KEY ?? "vidforge-secret",
};

// The gateway fetches playlist bytes over the internal endpoint (reachable
// from inside the network: minio:9000 / the S3 service endpoint).
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: "us-east-1",
  forcePathStyle: true, // required for MinIO
  credentials,
});

// Presigned URLs are handed to the browser, so they must embed a
// browser-reachable host — which in prod differs from the internal one.
const s3Public = new S3Client({
  endpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: "us-east-1",
  forcePathStyle: true,
  credentials,
});
```

with:

```typescript
import { resolveS3Config } from "../s3-config.js";

// The gateway fetches playlist bytes over the internal endpoint (reachable
// from inside the network: minio:9000 / the S3 service endpoint).
const s3 = new S3Client(resolveS3Config());

// Presigned URLs are handed to the browser, so they must embed a
// browser-reachable host — which in prod differs from the internal one.
const s3Public = new S3Client(resolveS3Config(process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT));
```

- [ ] **Step 7: Wire `resolveS3Config` into `dev.ts`**

Replace this block in `apps/api-gateway/src/routes/dev.ts`:

```typescript
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "vidforge",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "vidforge-secret",
  },
});
```

with:

```typescript
import { resolveS3Config } from "../s3-config.js";

const s3 = new S3Client(resolveS3Config());
```

(This route is gated behind `if (process.env.NODE_ENV === "production") return;` earlier in the file and never runs in ECS, but fixing it too keeps the pattern consistent across the package.)

- [ ] **Step 8: Run api-gateway's full test suite**

Run: `pnpm --filter @vidforge/api-gateway test`
Expected: PASS — the new `s3-config.test.ts` plus the existing `playlist.test.ts` and `config.test.ts`.

- [ ] **Step 9: Add vitest to video-svc**

`apps/video-svc/package.json` currently has no test runner. Modify its `scripts` and `devDependencies`:

```json
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx watch src/main.ts",
    "lint": "echo ok",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
```

```json
  "devDependencies": {
    "@types/fluent-ffmpeg": "^2.1.27",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^1.6.1"
  }
```

- [ ] **Step 10: Install the new dependency**

Run: `pnpm install`
Expected: `vitest` symlinked into `apps/video-svc/node_modules`.

- [ ] **Step 11: Write video-svc's resolver + test (same shape as Step 1, separate package)**

```typescript
// apps/video-svc/src/s3-config.ts
import type { S3ClientConfig } from "@aws-sdk/client-s3";

// See apps/api-gateway/src/s3-config.ts for the full rationale — same
// resolver, duplicated because this is a different package.
export function resolveS3Config(endpoint = process.env.S3_ENDPOINT): S3ClientConfig {
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;
  const explicitCreds = accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;

  return {
    endpoint,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: Boolean(explicitCreds),
    credentials: explicitCreds,
  };
}
```

```typescript
// apps/video-svc/src/s3-config.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { resolveS3Config } from "./s3-config.js";

const ENV_KEYS = ["S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_ENDPOINT", "S3_REGION"] as const;
const saved: Record<string, string | undefined> = {};

function clearEnv() {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("resolveS3Config", () => {
  it("uses explicit MinIO-shaped credentials and path-style when S3_ACCESS_KEY is set", () => {
    clearEnv();
    process.env.S3_ACCESS_KEY = "vidforge";
    process.env.S3_SECRET_KEY = "vidforge-secret";

    const config = resolveS3Config("http://localhost:9000");

    expect(config.credentials).toEqual({ accessKeyId: "vidforge", secretAccessKey: "vidforge-secret" });
    expect(config.forcePathStyle).toBe(true);
  });

  it("falls through to the SDK default credential chain when unset (prod/ECS shape)", () => {
    clearEnv();

    const config = resolveS3Config(process.env.S3_ENDPOINT);

    expect(config.credentials).toBeUndefined();
    expect(config.forcePathStyle).toBe(false);
    expect(config.endpoint).toBeUndefined();
  });
});
```

- [ ] **Step 12: Run video-svc's test to verify it passes**

Run: `pnpm --filter @vidforge/video-svc test`
Expected: PASS, 2 tests.

- [ ] **Step 13: Wire `resolveS3Config` into `storage.ts`**

Replace this block in `apps/video-svc/src/storage.ts`:

```typescript
export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: "us-east-1",
  forcePathStyle: true, // required for MinIO
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "vidforge",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "vidforge-secret",
  },
});
```

with:

```typescript
import { resolveS3Config } from "./s3-config.js";

export const s3 = new S3Client(resolveS3Config());
```

(Add the import alongside the existing `@aws-sdk/*` imports at the top of the file.)

- [ ] **Step 14: Typecheck both packages**

Run: `pnpm --filter @vidforge/api-gateway typecheck && pnpm --filter @vidforge/video-svc typecheck`
Expected: no errors.

- [ ] **Step 15: Commit**

```bash
git add apps/api-gateway/src/s3-config.ts apps/api-gateway/src/s3-config.test.ts \
  apps/api-gateway/src/routes/uploads.ts apps/api-gateway/src/routes/playback.ts apps/api-gateway/src/routes/dev.ts \
  apps/video-svc/package.json apps/video-svc/src/s3-config.ts apps/video-svc/src/s3-config.test.ts \
  apps/video-svc/src/storage.ts pnpm-lock.yaml
git commit -m "fix: S3 client falls through to IAM task role when no explicit key is set"
```

---

### Task 2: Web health-check route

**Files:**
- Create: `apps/web/app/api/health/route.ts`

**Interfaces:**
- Produces: `GET /api/health` → `200`, no body. Consumed by Task 7's ALB target group health check (`alb.tf`'s `aws_lb_target_group.web.health_check.path`) and the web image's own Docker `HEALTHCHECK` (out of scope to add here — the existing image has none for web; the ALB target group check alone is sufficient for this phase, matching the spec's "used both for its image HEALTHCHECK and the ALB target group" framing at the ALB-check level only, since adding a Dockerfile HEALTHCHECK is optional polish not required for ECS routing to work).

- [ ] **Step 1: Write the route**

```typescript
// apps/web/app/api/health/route.ts
export function GET() {
  return new Response(null, { status: 200 });
}
```

- [ ] **Step 2: Verify it locally**

Run: `pnpm --filter @vidforge/web dev` (in one terminal), then in another:
`curl -i http://localhost:3000/api/health`
Expected: `HTTP/1.1 200 OK`, empty body. Stop the dev server after confirming (Ctrl-C).

This is a trivial, fixed-response handler — no unit test needed; Task 14's live ALB target-group health check is the real end-to-end proof.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/api/health/route.ts
git commit -m "feat(web): add /api/health for the ALB target group"
```

---

### Task 3: Terraform bootstrap for Phase 3 — variables + ECR

**Files:**
- Modify: `infra/terraform/variables.tf`
- Create: `infra/terraform/ecr.tf`

**Interfaces:**
- Consumes: `var.project_name` (existing, Phase 2).
- Produces: `var.web_image_tag`, `var.api_gateway_image_tag`, `var.auth_svc_image_tag`, `var.video_svc_api_image_tag`, `var.video_svc_worker_image_tag`, `var.web_task_cpu`/`web_task_memory`, `var.gateway_task_cpu`/`gateway_task_memory`, `var.auth_task_cpu`/`auth_task_memory`, `var.video_api_task_cpu`/`video_api_task_memory`, `var.worker_task_cpu`/`worker_task_memory`, `var.worker_min_count`, `var.worker_max_count`, `var.alb_idle_timeout` — consumed by every task from here on. `aws_ecr_repository.web`, `.api_gateway`, `.auth_svc`, `.video_svc_api`, `.video_svc_worker` (their `.repository_url` and `.arn` consumed by Tasks 5, 7-10, 12).

- [ ] **Step 1: Append Phase 3 variables to `variables.tf`**

```hcl
# --- Phase 3: image tags (no defaults — always pass explicitly, the full
# git SHA of the commit each image was built from; see
# infra/scripts/build-and-push.sh) ---

variable "web_image_tag" {
  description = "Git SHA tag of the web image to deploy."
  type        = string
}

variable "api_gateway_image_tag" {
  description = "Git SHA tag of the api-gateway image to deploy."
  type        = string
}

variable "auth_svc_image_tag" {
  description = "Git SHA tag of the auth-svc image to deploy."
  type        = string
}

variable "video_svc_api_image_tag" {
  description = "Git SHA tag of the video-svc API image to deploy."
  type        = string
}

variable "video_svc_worker_image_tag" {
  description = "Git SHA tag of the video-svc worker image to deploy."
  type        = string
}

# --- Phase 3: task sizing (Fargate CPU units / MiB memory) ---

variable "web_task_cpu" {
  type    = number
  default = 256
}

variable "web_task_memory" {
  type    = number
  default = 512
}

variable "gateway_task_cpu" {
  type    = number
  default = 256
}

variable "gateway_task_memory" {
  type    = number
  default = 512
}

variable "auth_task_cpu" {
  type    = number
  default = 256
}

variable "auth_task_memory" {
  type    = number
  default = 512
}

variable "video_api_task_cpu" {
  type    = number
  default = 256
}

variable "video_api_task_memory" {
  type    = number
  default = 512
}

variable "worker_task_cpu" {
  description = "ffmpeg is the one CPU-heavy workload in this system."
  type        = number
  default     = 2048
}

variable "worker_task_memory" {
  type    = number
  default = 4096
}

variable "worker_min_count" {
  type    = number
  default = 1
}

variable "worker_max_count" {
  type    = number
  default = 4
}

# --- Phase 3: ALB ---

variable "alb_idle_timeout" {
  description = "ALB idle timeout in seconds. Must exceed the SSE job-progress stream's expected duration."
  type        = number
  default     = 120
}
```

- [ ] **Step 2: Write `ecr.tf`**

```hcl
resource "aws_ecr_repository" "web" {
  name                 = "${var.project_name}/web"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "api_gateway" {
  name                 = "${var.project_name}/api-gateway"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "auth_svc" {
  name                 = "${var.project_name}/auth-svc"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "video_svc_api" {
  name                 = "${var.project_name}/video-svc-api"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "video_svc_worker" {
  name                 = "${var.project_name}/video-svc-worker"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}
```

- [ ] **Step 3: Validate**

Run: `cd infra/terraform && terraform validate`
Expected: `Success! The configuration is valid.` (Fails if any earlier step has a syntax error — the five new image-tag variables have no default, so `terraform validate` alone won't complain, but `terraform plan` without `-var` for each would; that's expected and resolved in Step 4.)

- [ ] **Step 4: Plan**

Run: `terraform plan -out=/tmp/vidforge-phase3.tfplan -var='web_image_tag=placeholder' -var='api_gateway_image_tag=placeholder' -var='auth_svc_image_tag=placeholder' -var='video_svc_api_image_tag=placeholder' -var='video_svc_worker_image_tag=placeholder'`
Expected: plan succeeds, 5 resources to add (the ECR repositories), 0 to change, 0 to destroy. The placeholder image tag values are fine here — nothing in this plan yet references them (later tasks' plans will use the same placeholders until Task 14's real apply).

- [ ] **Step 5: Commit**

```bash
git add infra/terraform/variables.tf infra/terraform/ecr.tf
git commit -m "infra: add Phase 3 variables and ECR repositories"
```

---

### Task 4: Image build/push script

**Files:**
- Create: `infra/scripts/build-and-push.sh`

**Interfaces:**
- Consumes: nothing from Terraform state (computes the ECR registry URL itself via `aws sts get-caller-identity` + `aws configure get region`, so it works even before Task 3's repos are applied).
- Produces: pushed images at `<registry>/vidforge/<app>:<git-sha>` and `<registry>/vidforge/<app>:latest`. Consumed manually in Task 14 (the tag value is passed to `terraform apply -var=...`).

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Builds and pushes VidForge app images to ECR, tagged with the current
# git commit SHA (plus :latest for convenience — task definitions always
# pin the SHA tag, never :latest).
#
# Usage:
#   infra/scripts/build-and-push.sh              # all 5 images
#   infra/scripts/build-and-push.sh api-gateway   # just one
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Uncommitted changes present — commit or stash before building." >&2
  echo "The SHA tag must mean exactly the commit it names." >&2
  exit 1
fi

SHA=$(git rev-parse HEAD)
REGION=$(aws configure get region || echo "ap-south-1")
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

declare -A DOCKERFILES=(
  [web]="apps/web/Dockerfile"
  [api-gateway]="apps/api-gateway/Dockerfile"
  [auth-svc]="apps/auth-svc/Dockerfile"
  [video-svc-api]="apps/video-svc/Dockerfile"
  [video-svc-worker]="apps/video-svc/Dockerfile"
)
declare -A TARGETS=(
  [video-svc-api]="api"
  [video-svc-worker]="worker"
)
declare -A BUILD_ARGS=(
  # Empty string, not omitted: makes fetch() calls same-origin relative
  # paths through the ALB, avoiding CORS entirely. The Dockerfile's ARG
  # default (http://localhost:4000) only applies when the flag is absent.
  [web]="--build-arg NEXT_PUBLIC_GATEWAY_URL="
)

APPS=(web api-gateway auth-svc video-svc-api video-svc-worker)
if [[ $# -gt 0 ]]; then
  APPS=("$1")
fi

echo "--- ecr login ---"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

for app in "${APPS[@]}"; do
  dockerfile="${DOCKERFILES[$app]:-}"
  if [[ -z "$dockerfile" ]]; then
    echo "unknown app: $app" >&2
    exit 1
  fi
  repo="vidforge/${app}"
  target="${TARGETS[$app]:-}"
  target_flag=()
  [[ -n "$target" ]] && target_flag=(--target "$target")
  # shellcheck disable=SC2206
  extra_args=(${BUILD_ARGS[$app]:-})

  echo "--- building $app ---"
  docker build -f "$dockerfile" "${target_flag[@]}" "${extra_args[@]}" \
    -t "${REGISTRY}/${repo}:${SHA}" \
    -t "${REGISTRY}/${repo}:latest" \
    .

  echo "--- pushing $app ---"
  docker push "${REGISTRY}/${repo}:${SHA}"
  docker push "${REGISTRY}/${repo}:latest"
done

echo "--- done — image tag for this build: ${SHA} ---"
echo "Pass it to terraform apply as -var='web_image_tag=${SHA}' etc. (or all five)."
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x infra/scripts/build-and-push.sh`

- [ ] **Step 3: Syntax-check it**

Run: `bash -n infra/scripts/build-and-push.sh`
Expected: no output (syntax OK). Real functional testing needs Task 3's ECR repos to actually exist — deferred to Task 14, where it's run for real.

- [ ] **Step 4: Commit**

```bash
git add infra/scripts/build-and-push.sh
git commit -m "infra: add ECR build/push script"
```

---

### Task 5: ECS cluster & shared infrastructure

**Files:**
- Create: `infra/terraform/ecs-cluster.tf`

**Interfaces:**
- Consumes: `aws_vpc.main`, `aws_security_group.app`, `aws_ecr_repository.*` (Task 3), `aws_secretsmanager_secret.*` (Phase 2), `local.name_prefix` (Phase 2).
- Produces: `aws_ecs_cluster.main`, `aws_service_discovery_private_dns_namespace.internal`, `aws_iam_role.execution` (its `.arn` consumed by every task definition in Tasks 7-9, 10, 12), `aws_cloudwatch_log_group.{web,api_gateway,auth_svc,video_svc_api,transcode_worker,migrate}` (consumed by the matching task definition's `logConfiguration`).

- [ ] **Step 1: Write `ecs-cluster.tf`**

```hcl
resource "aws_ecs_cluster" "main" {
  name = local.name_prefix

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = {
    Name = local.name_prefix
  }
}

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name = "vidforge.local"
  vpc  = aws_vpc.main.id
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${local.name_prefix}/web"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/ecs/${local.name_prefix}/api-gateway"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "auth_svc" {
  name              = "/ecs/${local.name_prefix}/auth-svc"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "video_svc_api" {
  name              = "/ecs/${local.name_prefix}/video-svc-api"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "transcode_worker" {
  name              = "/ecs/${local.name_prefix}/transcode-worker"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/ecs/${local.name_prefix}/migrate"
  retention_in_days = 14
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name_prefix}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "ECRAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "ECRImagePull"
    actions = [
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [
      aws_ecr_repository.web.arn,
      aws_ecr_repository.api_gateway.arn,
      aws_ecr_repository.auth_svc.arn,
      aws_ecr_repository.video_svc_api.arn,
      aws_ecr_repository.video_svc_worker.arn,
    ]
  }

  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "${aws_cloudwatch_log_group.web.arn}:*",
      "${aws_cloudwatch_log_group.api_gateway.arn}:*",
      "${aws_cloudwatch_log_group.auth_svc.arn}:*",
      "${aws_cloudwatch_log_group.video_svc_api.arn}:*",
      "${aws_cloudwatch_log_group.transcode_worker.arn}:*",
      "${aws_cloudwatch_log_group.migrate.arn}:*",
    ]
  }

  statement {
    sid     = "Secrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.jwt_secret.arn,
      aws_secretsmanager_secret.context_signing_secret.arn,
      aws_secretsmanager_secret.database_url.arn,
      aws_secretsmanager_secret.smtp_url.arn,
    ]
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "${local.name_prefix}-ecs-execution"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# Internal gRPC calls between tasks (gateway -> auth-svc, gateway ->
# video-svc) flow through the shared app SG via Cloud Map — without these,
# tasks could reach the ALB but not each other.
resource "aws_security_group_rule" "app_internal_grpc_video" {
  type                     = "ingress"
  from_port                = 50051
  to_port                  = 50051
  protocol                 = "tcp"
  security_group_id        = aws_security_group.app.id
  source_security_group_id = aws_security_group.app.id
  description               = "Internal gRPC: gateway -> video-svc."
}

resource "aws_security_group_rule" "app_internal_grpc_auth" {
  type                     = "ingress"
  from_port                = 50053
  to_port                  = 50053
  protocol                 = "tcp"
  security_group_id        = aws_security_group.app.id
  source_security_group_id = aws_security_group.app.id
  description               = "Internal gRPC: gateway -> auth-svc."
}
```

- [ ] **Step 2: Validate**

Run: `terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Plan**

Run: `terraform plan -out=/tmp/vidforge-phase3.tfplan -var='web_image_tag=placeholder' -var='api_gateway_image_tag=placeholder' -var='auth_svc_image_tag=placeholder' -var='video_svc_api_image_tag=placeholder' -var='video_svc_worker_image_tag=placeholder'`
Expected: plan succeeds, 12 new resources on top of the previous total (cluster, namespace, 6 log groups, execution role, execution role policy, 2 security group rules).

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/ecs-cluster.tf
git commit -m "infra: add ECS cluster, Cloud Map namespace, execution role"
```

---

### Task 6: ALB

**Files:**
- Create: `infra/terraform/alb.tf`

**Interfaces:**
- Consumes: `aws_vpc.main`, `aws_subnet.public[*]` (Phase 2), `local.name_prefix` (Phase 2), `var.alb_idle_timeout` (Task 3).
- Produces: `aws_security_group.alb` (its `.id` consumed by Tasks 7-8's ingress rules), `aws_lb.main` (its `.dns_name` consumed by Task 8's `WEB_ORIGIN` and Task 13's output), `aws_lb_target_group.web` / `.api_gateway` (consumed by Tasks 7-8's `load_balancer` blocks), `aws_lb_listener.http` (consumed as a `depends_on` by Tasks 7-8's services, so ECS doesn't try registering targets before the listener exists).

- [ ] **Step 1: Write `alb.tf`**

```hcl
resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb"
  description = "Public HTTP ingress for the ALB."
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-alb-sg"
  }
}

resource "aws_lb" "main" {
  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
  idle_timeout       = var.alb_idle_timeout

  tags = {
    Name = "${local.name_prefix}-alb"
  }
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name_prefix}-web"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/api/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
    matcher             = "200"
  }

  tags = {
    Name = "${local.name_prefix}-web-tg"
  }
}

resource "aws_lb_target_group" "api_gateway" {
  name        = "${local.name_prefix}-gateway"
  port        = 4000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/healthz"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
    matcher             = "200"
  }

  tags = {
    Name = "${local.name_prefix}-gateway-tg"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

resource "aws_lb_listener_rule" "gateway_v1" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api_gateway.arn
  }

  condition {
    path_pattern {
      values = ["/v1/*"]
    }
  }
}

resource "aws_lb_listener_rule" "gateway_healthz" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 101

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api_gateway.arn
  }

  condition {
    path_pattern {
      values = ["/healthz"]
    }
  }
}
```

- [ ] **Step 2: Validate**

Run: `terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Plan**

Run: `terraform plan -out=/tmp/vidforge-phase3.tfplan -var='web_image_tag=placeholder' -var='api_gateway_image_tag=placeholder' -var='auth_svc_image_tag=placeholder' -var='video_svc_api_image_tag=placeholder' -var='video_svc_worker_image_tag=placeholder'`
Expected: 7 new resources (ALB SG, ALB, 2 target groups, listener, 2 listener rules).

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/alb.tf
git commit -m "infra: add ALB with path-based routing to web/gateway"
```

---

### Task 7: Web service

**Files:**
- Create: `infra/terraform/ecs-web.tf`

**Interfaces:**
- Consumes: `aws_ecs_cluster.main`, `aws_iam_role.execution`, `aws_cloudwatch_log_group.web` (Task 5); `aws_security_group.alb`, `aws_lb_target_group.web`, `aws_lb_listener.http` (Task 6); `aws_ecr_repository.web` (Task 3); `var.web_task_cpu`/`web_task_memory`, `var.web_image_tag` (Task 3).
- Produces: `aws_ecs_service.web`.

- [ ] **Step 1: Write `ecs-web.tf`**

```hcl
resource "aws_security_group_rule" "app_from_alb_web" {
  type                     = "ingress"
  from_port                = 3000
  to_port                  = 3000
  protocol                 = "tcp"
  security_group_id        = aws_security_group.app.id
  source_security_group_id = aws_security_group.alb.id
  description               = "ALB -> web."
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name_prefix}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_task_cpu
  memory                   = var.web_task_memory
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([
    {
      name        = "web"
      image       = "${aws_ecr_repository.web.repository_url}:${var.web_image_tag}"
      essential   = true
      stopTimeout = 30
      portMappings = [
        { containerPort = 3000, protocol = "tcp" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.web.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "web"
        }
      }
    }
  ])

  tags = {
    Name = "${local.name_prefix}-web"
  }
}

resource "aws_ecs_service" "web" {
  name            = "${local.name_prefix}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name    = "web"
    container_port    = 3000
  }

  depends_on = [aws_lb_listener.http, aws_iam_role_policy.execution]

  tags = {
    Name = "${local.name_prefix}-web"
  }
}
```

- [ ] **Step 2: Validate**

Run: `terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Plan**

Run: `terraform plan -out=/tmp/vidforge-phase3.tfplan -var='web_image_tag=placeholder' -var='api_gateway_image_tag=placeholder' -var='auth_svc_image_tag=placeholder' -var='video_svc_api_image_tag=placeholder' -var='video_svc_worker_image_tag=placeholder'`
Expected: 3 new resources (SG rule, task definition, service).

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/ecs-web.tf
git commit -m "infra: add web ECS task definition and service"
```

---

### Task 8: API gateway service

**Files:**
- Create: `infra/terraform/ecs-gateway.tf`

**Interfaces:**
- Consumes: `aws_ecs_cluster.main`, `aws_iam_role.execution`, `aws_cloudwatch_log_group.api_gateway`, `data.aws_iam_policy_document.ecs_assume` (Task 5); `aws_security_group.alb`, `aws_lb_target_group.api_gateway`, `aws_lb_listener.http`, `aws_lb.main.dns_name` (Task 6); `aws_ecr_repository.api_gateway` (Task 3); `aws_elasticache_cluster.main`, `aws_s3_bucket.media`, `aws_secretsmanager_secret.context_signing_secret`/`.database_url` (Phase 2); `var.gateway_task_cpu`/`gateway_task_memory`, `var.api_gateway_image_tag` (Task 3).
- Produces: `aws_iam_role.gateway_task`, `aws_ecs_service.api_gateway`.

- [ ] **Step 1: Write `ecs-gateway.tf`**

```hcl
resource "aws_security_group_rule" "app_from_alb_gateway" {
  type                     = "ingress"
  from_port                = 4000
  to_port                  = 4000
  protocol                 = "tcp"
  security_group_id        = aws_security_group.app.id
  source_security_group_id = aws_security_group.alb.id
  description               = "ALB -> api-gateway."
}

resource "aws_iam_role" "gateway_task" {
  name               = "${local.name_prefix}-gateway-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "gateway_task" {
  statement {
    sid = "MediaBucketObjects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:HeadObject",
    ]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }

  statement {
    sid       = "MediaBucketList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]
  }
}

resource "aws_iam_role_policy" "gateway_task" {
  name   = "${local.name_prefix}-gateway-task"
  role   = aws_iam_role.gateway_task.id
  policy = data.aws_iam_policy_document.gateway_task.json
}

resource "aws_ecs_task_definition" "api_gateway" {
  family                   = "${local.name_prefix}-api-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.gateway_task_cpu
  memory                   = var.gateway_task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn             = aws_iam_role.gateway_task.arn

  container_definitions = jsonencode([
    {
      name        = "api-gateway"
      image       = "${aws_ecr_repository.api_gateway.repository_url}:${var.api_gateway_image_tag}"
      essential   = true
      stopTimeout = 30
      portMappings = [
        { containerPort = 4000, protocol = "tcp" },
      ]
      environment = [
        { name = "AUTH_SVC_ADDR", value = "auth.vidforge.local:50053" },
        { name = "VIDEO_SVC_ADDR", value = "video.vidforge.local:50051" },
        { name = "WEB_ORIGIN", value = "http://${aws_lb.main.dns_name}" },
        { name = "TRUST_PROXY", value = "true" },
        { name = "RATE_LIMIT_REDIS_URL", value = "redis://${aws_elasticache_cluster.main.cache_nodes[0].address}:6379" },
        { name = "S3_BUCKET", value = aws_s3_bucket.media.bucket },
        { name = "S3_REGION", value = var.aws_region },
      ]
      secrets = [
        { name = "CONTEXT_SIGNING_SECRET", valueFrom = aws_secretsmanager_secret.context_signing_secret.arn },
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api_gateway.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "api-gateway"
        }
      }
    }
  ])

  tags = {
    Name = "${local.name_prefix}-api-gateway"
  }
}

resource "aws_ecs_service" "api_gateway" {
  name            = "${local.name_prefix}-api-gateway"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api_gateway.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api_gateway.arn
    container_name    = "api-gateway"
    container_port    = 4000
  }

  depends_on = [aws_lb_listener.http, aws_iam_role_policy.execution]

  tags = {
    Name = "${local.name_prefix}-api-gateway"
  }
}
```

**Note:** `S3_BUCKET` must be set explicitly — the app code defaults to the literal string `"vidforge-media"` (matching local dev), but the real bucket is `${local.name_prefix}-media` = `vidforge-prod-media`. Without this, every S3 call in prod would 403/404 against a bucket that doesn't exist.

- [ ] **Step 2: Validate**

Run: `terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Plan**

Run: `terraform plan -out=/tmp/vidforge-phase3.tfplan -var='web_image_tag=placeholder' -var='api_gateway_image_tag=placeholder' -var='auth_svc_image_tag=placeholder' -var='video_svc_api_image_tag=placeholder' -var='video_svc_worker_image_tag=placeholder'`
Expected: 5 new resources (SG rule, task role, task role policy, task definition, service).

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/ecs-gateway.tf
git commit -m "infra: add api-gateway ECS task definition and service"
```

---

### Task 9: Auth-svc service

**Files:**
- Create: `infra/terraform/ecs-auth.tf`

**Interfaces:**
- Consumes: `aws_ecs_cluster.main`, `aws_iam_role.execution`, `aws_cloudwatch_log_group.auth_svc`, `aws_service_discovery_private_dns_namespace.internal` (Task 5); `aws_ecr_repository.auth_svc` (Task 3); `aws_secretsmanager_secret.jwt_secret`/`.context_signing_secret`/`.database_url`/`.smtp_url` (Phase 2); `var.auth_task_cpu`/`auth_task_memory`, `var.auth_svc_image_tag` (Task 3).
- Produces: `aws_service_discovery_service.auth_svc` (registers `auth.vidforge.local`, consumed by Task 8's `AUTH_SVC_ADDR` — already wired by name in Task 8, this task is what makes that name resolve), `aws_ecs_service.auth_svc`.

- [ ] **Step 1: Write `ecs-auth.tf`**

```hcl
resource "aws_service_discovery_service" "auth_svc" {
  name = "auth"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.internal.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_ecs_task_definition" "auth_svc" {
  family                   = "${local.name_prefix}-auth-svc"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.auth_task_cpu
  memory                   = var.auth_task_memory
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([
    {
      name        = "auth-svc"
      image       = "${aws_ecr_repository.auth_svc.repository_url}:${var.auth_svc_image_tag}"
      essential   = true
      stopTimeout = 30
      portMappings = [
        { containerPort = 50053, protocol = "tcp" },
      ]
      secrets = [
        { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.jwt_secret.arn },
        { name = "CONTEXT_SIGNING_SECRET", valueFrom = aws_secretsmanager_secret.context_signing_secret.arn },
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
        { name = "SMTP_URL", valueFrom = aws_secretsmanager_secret.smtp_url.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.auth_svc.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "auth-svc"
        }
      }
    }
  ])

  tags = {
    Name = "${local.name_prefix}-auth-svc"
  }
}

resource "aws_ecs_service" "auth_svc" {
  name            = "${local.name_prefix}-auth-svc"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.auth_svc.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.auth_svc.arn
  }

  depends_on = [aws_iam_role_policy.execution]

  tags = {
    Name = "${local.name_prefix}-auth-svc"
  }
}
```

**Note:** `SMTP_URL` still resolves to Phase 2's placeholder secret value (`REPLACE_ME_AFTER_SES_DOMAIN_VERIFICATION`) — SES provisioning remains out of scope for this phase too. Invite emails will fail to send until that's done; everything else works.

- [ ] **Step 2: Validate**

Run: `terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Plan**

Run: `terraform plan -out=/tmp/vidforge-phase3.tfplan -var='web_image_tag=placeholder' -var='api_gateway_image_tag=placeholder' -var='auth_svc_image_tag=placeholder' -var='video_svc_api_image_tag=placeholder' -var='video_svc_worker_image_tag=placeholder'`
Expected: 3 new resources (Cloud Map service, task definition, service).

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/ecs-auth.tf
git commit -m "infra: add auth-svc ECS task definition and service"
```

---

### Task 10: Video-svc API + transcode-worker services, queue-depth metric publisher

**Files:**
- Create: `infra/terraform/ecs-video.tf`
- Modify: `apps/video-svc/src/worker-main.ts`
- Modify: `apps/video-svc/package.json`

**Interfaces:**
- Consumes: `aws_ecs_cluster.main`, `aws_iam_role.execution`, `aws_cloudwatch_log_group.video_svc_api`/`.transcode_worker`, `aws_service_discovery_private_dns_namespace.internal`, `data.aws_iam_policy_document.ecs_assume` (Task 5); `aws_ecr_repository.video_svc_api`/`.video_svc_worker` (Task 3); `aws_s3_bucket.media`, `aws_secretsmanager_secret.context_signing_secret`/`.database_url` (Phase 2); `createTranscodeQueue` from `@vidforge/queue` (existing).
- Produces: `aws_service_discovery_service.video_svc` (registers `video.vidforge.local`), `aws_iam_role.video_api_task`, `aws_iam_role.worker_task` (its permissions consumed by Task 11's autoscaling — the `cloudwatch:PutMetricData` statement is what makes the worker's own metric publish succeed), `aws_ecs_service.video_svc_api`, `aws_ecs_service.transcode_worker` (its name consumed by Task 11's `aws_appautoscaling_target.resource_id`).

- [ ] **Step 1: Write the failing behavior check for the metric publisher**

There's no existing test harness for `worker-main.ts` (it's a thin process-lifecycle entrypoint, not a pure function — see `apps/video-svc/src/worker.ts` for where the actual testable logic lives). This step is manual: after Step 2's implementation, Step 3 verifies it by reading the code for the one thing that matters — that `getWaitingCount()` and `PutMetricDataCommand` are both called on the interval, with the right namespace/metric/dimension names that Task 11's CloudWatch alarms will filter on.

- [ ] **Step 2: Add the CloudWatch SDK dependency**

Modify `apps/video-svc/package.json`'s `dependencies`:

```json
  "dependencies": {
    "@aws-sdk/client-cloudwatch": "^3.1065.0",
    "@aws-sdk/client-s3": "^3.1065.0",
    "@aws-sdk/lib-storage": "^3.1065.0",
    "@grpc/grpc-js": "^1.12.5",
    "@vidforge/db": "workspace:*",
    "@vidforge/grpc-health": "workspace:*",
    "@vidforge/proto": "workspace:*",
    "@vidforge/queue": "workspace:*",
    "@vidforge/svc-auth": "workspace:^",
    "bullmq": "^5.34.8",
    "fluent-ffmpeg": "^2.1.3"
  },
```

Run: `pnpm install`
Expected: `@aws-sdk/client-cloudwatch` symlinked into `apps/video-svc/node_modules`.

- [ ] **Step 3: Publish queue depth from the worker**

Modify `apps/video-svc/src/worker-main.ts` — replace the whole file:

```typescript
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { createTranscodeQueue } from "@vidforge/queue";
import { startWorker } from "./worker.js";

const worker = startWorker();

// Autoscaling signal for the worker service (infra/terraform/ecs-autoscaling.tf):
// ECS/CloudWatch have no native concept of "BullMQ queue depth", so the
// worker publishes it itself. Namespace/metric/dimension names here must
// match the CloudWatch alarms exactly, or the autoscaling policy never
// fires.
const QUEUE_METRIC_NAMESPACE = "VidForge/Queue";
const QUEUE_METRIC_INTERVAL_MS = 30_000;

const cloudwatch = new CloudWatchClient({});
const queue = createTranscodeQueue();

const metricInterval = setInterval(() => {
  void queue
    .getWaitingCount()
    .then((count) =>
      cloudwatch.send(
        new PutMetricDataCommand({
          Namespace: QUEUE_METRIC_NAMESPACE,
          MetricData: [
            {
              MetricName: "WaitingJobs",
              Value: count,
              Unit: "Count",
              Dimensions: [{ Name: "QueueName", Value: "transcode" }],
            },
          ],
        }),
      ),
    )
    .catch((err) => console.error("failed to publish queue depth metric:", err));
}, QUEUE_METRIC_INTERVAL_MS);

// ECS sends SIGTERM on deploy/scale-in; close() waits for the in-flight
// job to finish (or be requeued) before exiting.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, draining worker`);
    clearInterval(metricInterval);
    void worker.close().then(() => process.exit(0));
  });
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @vidforge/video-svc typecheck`
Expected: no errors.

- [ ] **Step 5: Write `ecs-video.tf`**

```hcl
resource "aws_service_discovery_service" "video_svc" {
  name = "video"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.internal.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_iam_role" "video_api_task" {
  name               = "${local.name_prefix}-video-api-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "video_api_task" {
  statement {
    sid = "MediaBucketObjects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:HeadObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }

  statement {
    sid       = "MediaBucketList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]
  }
}

resource "aws_iam_role_policy" "video_api_task" {
  name   = "${local.name_prefix}-video-api-task"
  role   = aws_iam_role.video_api_task.id
  policy = data.aws_iam_policy_document.video_api_task.json
}

resource "aws_ecs_task_definition" "video_svc_api" {
  family                   = "${local.name_prefix}-video-svc-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.video_api_task_cpu
  memory                   = var.video_api_task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn             = aws_iam_role.video_api_task.arn

  container_definitions = jsonencode([
    {
      name        = "video-svc-api"
      image       = "${aws_ecr_repository.video_svc_api.repository_url}:${var.video_svc_api_image_tag}"
      essential   = true
      stopTimeout = 30
      portMappings = [
        { containerPort = 50051, protocol = "tcp" },
      ]
      environment = [
        { name = "S3_BUCKET", value = aws_s3_bucket.media.bucket },
        { name = "S3_REGION", value = var.aws_region },
      ]
      secrets = [
        { name = "CONTEXT_SIGNING_SECRET", valueFrom = aws_secretsmanager_secret.context_signing_secret.arn },
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.video_svc_api.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "video-svc-api"
        }
      }
    }
  ])

  tags = {
    Name = "${local.name_prefix}-video-svc-api"
  }
}

resource "aws_ecs_service" "video_svc_api" {
  name            = "${local.name_prefix}-video-svc-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.video_svc_api.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.video_svc.arn
  }

  depends_on = [aws_iam_role_policy.execution]

  tags = {
    Name = "${local.name_prefix}-video-svc-api"
  }
}

resource "aws_iam_role" "worker_task" {
  name               = "${local.name_prefix}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "worker_task" {
  statement {
    sid = "MediaBucketObjects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:HeadObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }

  statement {
    sid       = "MediaBucketList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]
  }

  statement {
    sid       = "QueueDepthMetric"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"] # PutMetricData has no resource-level permissions; scoped by the condition below instead.

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["VidForge/Queue"]
    }
  }
}

resource "aws_iam_role_policy" "worker_task" {
  name   = "${local.name_prefix}-worker-task"
  role   = aws_iam_role.worker_task.id
  policy = data.aws_iam_policy_document.worker_task.json
}

resource "aws_ecs_task_definition" "transcode_worker" {
  family                   = "${local.name_prefix}-transcode-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_task_cpu
  memory                   = var.worker_task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn             = aws_iam_role.worker_task.arn

  container_definitions = jsonencode([
    {
      name        = "transcode-worker"
      image       = "${aws_ecr_repository.video_svc_worker.repository_url}:${var.video_svc_worker_image_tag}"
      essential   = true
      stopTimeout = 120
      environment = [
        { name = "S3_BUCKET", value = aws_s3_bucket.media.bucket },
        { name = "S3_REGION", value = var.aws_region },
      ]
      secrets = [
        { name = "CONTEXT_SIGNING_SECRET", valueFrom = aws_secretsmanager_secret.context_signing_secret.arn },
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.transcode_worker.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])

  tags = {
    Name = "${local.name_prefix}-transcode-worker"
  }
}

resource "aws_ecs_service" "transcode_worker" {
  name            = "${local.name_prefix}-transcode-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.transcode_worker.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  depends_on = [aws_iam_role_policy.execution]

  # Task 11's Application Auto Scaling policy changes desired_count out of
  # band; without this, a later `terraform apply` would fight the scaler
  # and reset it back to 1.
  lifecycle {
    ignore_changes = [desired_count]
  }

  tags = {
    Name = "${local.name_prefix}-transcode-worker"
  }
}
```

- [ ] **Step 6: Validate**

Run: `terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 7: Plan**

Run: `terraform plan -out=/tmp/vidforge-phase3.tfplan -var='web_image_tag=placeholder' -var='api_gateway_image_tag=placeholder' -var='auth_svc_image_tag=placeholder' -var='video_svc_api_image_tag=placeholder' -var='video_svc_worker_image_tag=placeholder'`
Expected: 9 new resources (Cloud Map service, 2 task roles, 2 task role policies, 2 task definitions, 2 services).

- [ ] **Step 8: Commit**

```bash
git add infra/terraform/ecs-video.tf apps/video-svc/src/worker-main.ts apps/video-svc/package.json pnpm-lock.yaml
git commit -m "infra: add video-svc API and worker ECS services; worker publishes queue depth"
```

---

### Task 11: Worker autoscaling

**Files:**
- Create: `infra/terraform/ecs-autoscaling.tf`

**Interfaces:**
- Consumes: `aws_ecs_cluster.main` (Task 5), `aws_ecs_service.transcode_worker` (Task 10), `var.worker_min_count`/`worker_max_count` (Task 3). The `VidForge/Queue` namespace / `WaitingJobs` metric / `QueueName=transcode` dimension published by Task 10's `worker-main.ts` — must match exactly or the alarms never enter `ALARM` state.
- Produces: `aws_appautoscaling_target.worker`, `aws_appautoscaling_policy.worker_scale_out`/`.worker_scale_in`, `aws_cloudwatch_metric_alarm.worker_queue_high`/`.worker_queue_low`.

- [ ] **Step 1: Write `ecs-autoscaling.tf`**

```hcl
resource "aws_appautoscaling_target" "worker" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.transcode_worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.worker_min_count
  max_capacity       = var.worker_max_count
}

resource "aws_appautoscaling_policy" "worker_scale_out" {
  name               = "${local.name_prefix}-worker-scale-out"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  policy_type        = "StepScaling"

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 60
    metric_aggregation_type = "Maximum"

    step_adjustment {
      metric_interval_lower_bound = 0
      scaling_adjustment           = 1
    }
  }
}

resource "aws_appautoscaling_policy" "worker_scale_in" {
  name               = "${local.name_prefix}-worker-scale-in"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  policy_type        = "StepScaling"

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 300
    metric_aggregation_type = "Maximum"

    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment           = -1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_queue_high" {
  alarm_name          = "${local.name_prefix}-worker-queue-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods   = 2
  metric_name          = "WaitingJobs"
  namespace             = "VidForge/Queue"
  period                = 60
  statistic              = "Maximum"
  threshold              = 5

  dimensions = {
    QueueName = "transcode"
  }

  alarm_actions = [aws_appautoscaling_policy.worker_scale_out.arn]
}

resource "aws_cloudwatch_metric_alarm" "worker_queue_low" {
  alarm_name          = "${local.name_prefix}-worker-queue-low"
  comparison_operator = "LessThanOrEqualToThreshold"
  evaluation_periods   = 5
  metric_name          = "WaitingJobs"
  namespace             = "VidForge/Queue"
  period                = 60
  statistic              = "Maximum"
  threshold              = 0

  dimensions = {
    QueueName = "transcode"
  }

  alarm_actions = [aws_appautoscaling_policy.worker_scale_in.arn]
}
```

- [ ] **Step 2: Validate**

Run: `terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Plan**

Run: `terraform plan -out=/tmp/vidforge-phase3.tfplan -var='web_image_tag=placeholder' -var='api_gateway_image_tag=placeholder' -var='auth_svc_image_tag=placeholder' -var='video_svc_api_image_tag=placeholder' -var='video_svc_worker_image_tag=placeholder'`
Expected: 5 new resources (appautoscaling target, 2 policies, 2 alarms).

- [ ] **Step 4: Commit**

```bash
git add infra/terraform/ecs-autoscaling.tf
git commit -m "infra: add worker autoscaling on queue depth"
```

---

### Task 12: Migration task + run script

**Files:**
- Create: `infra/terraform/ecs-migration.tf`
- Modify: `infra/terraform/outputs.tf`
- Create: `infra/scripts/run-migration.sh`

**Interfaces:**
- Consumes: `aws_ecs_cluster.main`, `aws_iam_role.execution`, `aws_cloudwatch_log_group.migrate` (Task 5); `aws_ecr_repository.api_gateway` (Task 3, reuses its image — same as `docker-compose.prod.yml`'s `migrate` service); `aws_secretsmanager_secret.database_url` (Phase 2); `var.api_gateway_image_tag` (Task 3).
- Produces: `aws_ecs_task_definition.migrate` (its `.arn` exposed as the new `migration_task_definition_arn` output), plus new outputs `ecs_cluster_name` and `migration_task_definition_arn` — both consumed by `run-migration.sh` and, in Task 14, by the operator running it.

- [ ] **Step 1: Write `ecs-migration.tf`**

```hcl
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name_prefix}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn

  container_definitions = jsonencode([
    {
      name             = "migrate"
      image            = "${aws_ecr_repository.api_gateway.repository_url}:${var.api_gateway_image_tag}"
      essential        = true
      workingDirectory = "/app"
      command          = ["pnpm", "--filter", "@vidforge/db", "db:deploy"]
      secrets = [
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.migrate.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "migrate"
        }
      }
    }
  ])

  tags = {
    Name = "${local.name_prefix}-migrate"
  }
}
```

**Note:** `workingDirectory` is set to `/app` (the pnpm workspace root inside the image), overriding the api-gateway Dockerfile's own default `WORKDIR /app/apps/api-gateway` — exactly matching how `docker-compose.prod.yml`'s `migrate` service does this (`working_dir: /app`). No matching `aws_ecs_service` — this task def is run on demand via `aws ecs run-task`, never as a standing service.

- [ ] **Step 2: Append the two new outputs `run-migration.sh` needs**

```hcl
output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "migration_task_definition_arn" {
  value = aws_ecs_task_definition.migrate.arn
}
```

- [ ] **Step 3: Write `run-migration.sh`**

```bash
#!/usr/bin/env bash
# Runs the one-off DB migration task on ECS and waits for it to finish.
# Run this before every deploy that includes a new migration.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/infra/terraform"

CLUSTER=$(terraform output -raw ecs_cluster_name)
SUBNETS=$(terraform output -json private_subnet_ids | jq -r 'join(",")')
SG=$(terraform output -raw app_security_group_id)
TASK_DEF=$(terraform output -raw migration_task_definition_arn)

echo "--- starting migration task ---"
TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEF" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)

echo "task: $TASK_ARN"
echo "--- waiting for it to stop ---"
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)

if [[ "$EXIT_CODE" != "0" ]]; then
  echo "migration failed: exit code $EXIT_CODE — check CloudWatch Logs group /ecs/${CLUSTER}/migrate" >&2
  exit 1
fi
echo "--- migration succeeded ---"
```

- [ ] **Step 4: Make it executable**

Run: `chmod +x infra/scripts/run-migration.sh`

- [ ] **Step 5: Syntax-check it**

Run: `bash -n infra/scripts/run-migration.sh`
Expected: no output. Real functional testing needs Task 14's applied cluster/task def — deferred there, run for real right after the migration is actually needed.

- [ ] **Step 6: Validate**

Run: `terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 7: Plan**

Run: `terraform plan -out=/tmp/vidforge-phase3.tfplan -var='web_image_tag=placeholder' -var='api_gateway_image_tag=placeholder' -var='auth_svc_image_tag=placeholder' -var='video_svc_api_image_tag=placeholder' -var='video_svc_worker_image_tag=placeholder'`
Expected: 1 new resource (the migration task definition); outputs change but aren't counted as resources to add/change/destroy.

- [ ] **Step 8: Commit**

```bash
git add infra/terraform/ecs-migration.tf infra/terraform/outputs.tf infra/scripts/run-migration.sh
git commit -m "infra: add one-off migration task and run script"
```

---

### Task 13: Final outputs, format check, full-plan review

**Files:**
- Modify: `infra/terraform/outputs.tf`

**Interfaces:**
- Consumes: `aws_lb.main` (Task 6).
- Produces: `alb_dns_name` output, consumed manually in Task 14's verification step.

- [ ] **Step 1: Append the ALB DNS name output**

```hcl
output "alb_dns_name" {
  description = "Public HTTP entrypoint for the app — http://<this value>/"
  value       = aws_lb.main.dns_name
}
```

- [ ] **Step 2: Format check**

Run: `terraform fmt -check -recursive`
Expected: no output. If files are listed, run `terraform fmt -recursive` and re-check.

- [ ] **Step 3: Validate**

Run: `terraform validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 4: Full plan (still placeholder image tags)**

Run: `terraform plan -out=/tmp/vidforge-phase3.tfplan -var='web_image_tag=placeholder' -var='api_gateway_image_tag=placeholder' -var='auth_svc_image_tag=placeholder' -var='video_svc_api_image_tag=placeholder' -var='video_svc_worker_image_tag=placeholder'`
Expected: plan succeeds, 0 errors, ~50 resources to add (5 ECR + 12 cluster/shared + 7 ALB + 3 web + 5 gateway + 3 auth + 9 video/worker + 5 autoscaling + 1 migration), 0 to change, 0 to destroy — Phase 2's already-applied resources show no drift. Read through the plan for anything unexpected before Task 14. The placeholder image tags are fine for this review; Task 14 replaces them with the real git SHA before applying.

- [ ] **Step 5: Commit**

```bash
git add infra/terraform/outputs.tf
git commit -m "infra: add ALB DNS name output"
```

---

### Task 14: Gated apply, build & push, migrate, verify

**Files:** none (no new files — this task runs the plan built up across Tasks 3-13, plus the scripts written in Tasks 4 and 12).

**Interfaces:**
- Consumes: every resource produced in Tasks 3-13; `infra/scripts/build-and-push.sh` (Task 4); `infra/scripts/run-migration.sh` (Task 12).
- Produces: real AWS resources (ECR images, ECS cluster/services, ALB) and a migrated production database; no code artifacts.

This is a two-stage apply, not one — a real technical constraint, not a stylistic choice: ECR repositories must exist before images can be pushed to them, and the ECS services must not be created until the images they reference actually exist in ECR (otherwise `aws_ecs_service`'s built-in wait-for-steady-state fails because tasks can't pull an image that was never pushed).

- [ ] **Step 1: Present the plan to the operator**

Show the full output of `terraform show /tmp/vidforge-phase3.tfplan` (from Task 13's plan) to the user. Summarize: ~50 resources to add, all creates, and that this adds real ongoing cost on top of Phase 2's (ALB ~$20/mo, 5 Fargate tasks at the sizes in Task 3's variables ~$40-70/mo depending on how much the worker autoscales — see the design doc's cost table).

- [ ] **Step 2: STOP — get explicit confirmation**

Do not proceed to Step 3 until the operator explicitly confirms. Hard gate, same as Phase 2's Task 8 — a plan that "looks fine" is not confirmation. If executing via subagent-driven-development, this must escalate back to the primary conversation.

- [ ] **Step 3: Apply the ECR repositories only**

Run: `terraform apply -target=aws_ecr_repository.web -target=aws_ecr_repository.api_gateway -target=aws_ecr_repository.auth_svc -target=aws_ecr_repository.video_svc_api -target=aws_ecr_repository.video_svc_worker -var='web_image_tag=placeholder' -var='api_gateway_image_tag=placeholder' -var='auth_svc_image_tag=placeholder' -var='video_svc_api_image_tag=placeholder' -var='video_svc_worker_image_tag=placeholder'`
Expected: `Apply complete! Resources: 5 added, 0 changed, 0 destroyed.` (The placeholder tag values are irrelevant here — nothing in this targeted apply references them.)

- [ ] **Step 4: Build and push all five images**

Run: `infra/scripts/build-and-push.sh`
Expected: all five images build and push successfully. Note the printed git SHA — it's the value every `_image_tag` variable needs in Step 5.

- [ ] **Step 5: Apply everything else**

Run: `terraform apply -var='web_image_tag=<SHA>' -var='api_gateway_image_tag=<SHA>' -var='auth_svc_image_tag=<SHA>' -var='video_svc_api_image_tag=<SHA>' -var='video_svc_worker_image_tag=<SHA>'` (same `<SHA>` from Step 4 for all five — one commit, one set of images).
Expected: `Apply complete! Resources: ~45 added, 0 changed, 0 destroyed.` (This step blocks until every `aws_ecs_service` reaches steady state — i.e., its task is actually running and, for web/gateway, passing the ALB health check. Budget a few minutes.)

- [ ] **Step 6: Run the migration**

Run: `infra/scripts/run-migration.sh`
Expected: `--- migration succeeded ---`. This must run before the app is exercised — auth-svc/api-gateway/video-svc will error on every Prisma call otherwise (`User.passwordHash` etc. won't exist yet on a brand-new RDS instance, same class of error as the local dev-stack migration-drift incident documented in `.claude/skills/run-dev-stack/SKILL.md`, except here it's simply because migrations have never run at all).

- [ ] **Step 7: Verify ECS services are healthy**

```bash
cd infra/terraform
CLUSTER=$(terraform output -raw ecs_cluster_name)
aws ecs describe-services --cluster "$CLUSTER" \
  --services vidforge-prod-web vidforge-prod-api-gateway vidforge-prod-auth-svc vidforge-prod-video-svc-api vidforge-prod-transcode-worker \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount}'
```

Expected: `running == desired` (1 and 1) for every service.

- [ ] **Step 8: Verify over HTTP through the ALB**

```bash
ALB=$(terraform output -raw alb_dns_name)
curl -i "http://$ALB/healthz"                    # -> gateway, expect 200 {"ok":true}
curl -i "http://$ALB/"                             # -> web, expect 200
curl -i -X POST "http://$ALB/v1/auth/signup" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Phase 3 Smoke Test","email":"phase3-smoke@example.com","password":"smoketestpassword123"}'
```

Expected: `/healthz` → `200`; `/` → `200` (the Next.js dashboard HTML); signup → `200`/`201` with a token, proving the full chain — ALB → web/gateway (same origin, no CORS config needed) → gateway → auth-svc (Cloud Map) → RDS (migrated schema) → response back through the ALB. (`/v1/dev/login` is **not** available here — every image was built with `NODE_ENV=production` baked in by its Dockerfile, which disables `registerDevRoutes` entirely; this is why Step 8 uses the real signup endpoint instead.)

- [ ] **Step 9: Record outputs**

```bash
terraform output -json > /tmp/vidforge-phase3-outputs.json
```

No commit needed — outputs are derived, not source, same as Phase 2's Task 8.

---

## Self-Review Notes

- **Spec coverage:** ECR (Task 3-4), ECS cluster & networking (Task 5), S3 client fix (Task 1), task definitions & services (Tasks 7-10), ALB (Task 6), worker autoscaling (Tasks 10-11), migration task (Task 12), Terraform file layout (matches the spec's file list exactly), validation-before-apply (Tasks 3-13 plan-only, Task 14 gated apply) all map to the spec's numbered components. The web health-check route (spec §4) is Task 2. Out-of-scope items (HTTPS/ACM/Route53, GitHub Actions pipeline, metadata-svc, CloudFront/mTLS/WAF, SES provisioning, non-worker autoscaling) are not implemented anywhere in this plan, matching the spec.
- **Placeholder scan:** No TBD/TODO markers. The `placeholder` image-tag values used in Tasks 3-13's `terraform plan` commands are intentional and explicit — those tasks only ever plan (dry run), never apply; Task 14 replaces them with the real git SHA before the one apply that matters.
- **Type/name consistency:** `resolveS3Config(endpoint?: string): S3ClientConfig` (Task 1) is called identically (`resolveS3Config()` or with an explicit endpoint arg) in all four modified route/storage files. `aws_security_group.app`, `aws_subnet.private[*]`, `local.name_prefix` (Phase 2) are referenced identically across Tasks 5-12. `aws_iam_role.execution` (Task 5) is referenced as `execution_role_arn` in every task definition (Tasks 7, 8, 9, 10, 12). `aws_ecs_service.transcode_worker.name` (Task 10) matches the resource Task 11's `aws_appautoscaling_target.resource_id` interpolates. The `VidForge/Queue` namespace, `WaitingJobs` metric name, and `QueueName=transcode` dimension are identical between Task 10's `worker-main.ts` publisher and Task 11's CloudWatch alarms — a mismatch here would silently make autoscaling never fire, so this was checked character-by-character.
- **Sequencing check specific to this plan (Phase 2 didn't have this issue):** Task 14's two-stage apply (ECR-only, then everything else) is a real AWS/Terraform ordering constraint, not stylistic — `aws_ecs_service` blocks on steady state, which requires the referenced image to already exist. Documented explicitly in Task 14's preamble rather than left implicit.
