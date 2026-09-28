# Viewer Portal — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend (Prisma schema, gRPC proto + `auth-svc` RPCs, `api-gateway` HTTP routes) that lets an org's own customers ("viewers") activate an account, log in, browse a published-only asset library, stream HLS video, and track watch progress/history — while org staff can publish/unpublish assets, invite/revoke viewers, and set portal branding.

**Architecture:** Reuses the existing `apps/auth-svc` (new viewer RPCs alongside the existing staff ones) and `apps/api-gateway` (new `/v1/portal/*` route group plus additions to existing route files) rather than standing up new services. Viewer identity is structurally separate from staff identity: a viewer JWT carries a `kind: "viewer"` claim, `VerifyToken` returns a `ViewerContext` for it (never a staff `RequestContext`), and the gateway's new `requireViewer` preHandler only accepts that — so a viewer token cannot satisfy a staff-only route or vice versa. `playback.ts`'s manifest-fetch/presign logic is extracted into shared functions so staff and portal playback routes share code instead of forking it.

**Tech Stack:** Fastify, `@grpc/grpc-js`, Prisma (Postgres), `jose` (JWT), `zod`, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-28-viewer-portal-design.md`

**Follow-up plan:** A second plan covers `apps/web` UI additions (publish toggle, Viewers panel, org branding form) and the new `apps/viewer` Next.js app — both depend on this plan's API surface and are written separately once this one is reviewed.

## Global Constraints

- Migrations are additive only, applied via `pnpm db:migrate` / `pnpm db:deploy` — never `prisma db push` (repo-wide rule; CI's `db:drift-check` enforces it).
- Viewer and staff identity must be structurally incompatible: `requireViewer` never accepts a `RequestContext`-shaped token and `requireRole` never accepts a `ViewerContext`-shaped one, by construction (not just by convention).
- v1 scope only: flat library (no Collections/rows), no theming/custom domains, no native clients. Don't build toward these.
- No new services/infra — this reuses `apps/api-gateway` and `apps/auth-svc` (AWS infra was torn down 2026-09-25; no new ECS task/Cloud Map/ECR work here).
- `/v1/portal/auth/*` is rate-limited via the existing `@fastify/rate-limit` registration (`global: false`, opt-in per route via `config.rateLimit`).
- Never touch the existing staff `User`/`Role` model or its permission checks.

## Review Focus

- A revoked viewer must be locked out immediately, not just at their next login: `VerifyToken` re-checks the `Viewer` row (including `revokedAt`) on every call, the same way it re-checks `User.mustChangePassword` for staff — a stale already-issued session JWT must stop working the moment it's revoked, not just block future logins.
- A viewer JWT from org A must never see or touch org B's assets/jobs/progress through any `/v1/portal/*` route — every portal query must be scoped by the viewer's own `orgId`, not a client-supplied one.
- Unpublishing an asset while a viewer is mid-playback must cut off access within one manifest refresh (spec's stated behavior) — the publish check has to run on every `hls`/`thumbnails` request, not just at library-list time.
- Re-inviting a viewer must branch correctly on their current state: an un-activated viewer gets their invite token rotated (idempotent resend), an already-activated one is rejected as a no-op — both paths need a test, not just the happy path.
- A staff JWT presented to `requireViewer` and a viewer JWT presented to `requireRole` must both be rejected — this is the core "incompatible by construction" guarantee and deserves an explicit cross-contamination test at both the gateway and `VerifyToken` layers.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/db/prisma/schema.prisma` | `Org.slug/displayName/logoStorageKey`, `Asset.publishedAt`, new `Viewer`/`WatchProgress` models |
| `packages/db/prisma/migrations/<ts>_viewer_portal_and_publishing/migration.sql` | Hand-written additive migration incl. `Org.slug` backfill |
| `packages/proto/src/auth.proto` | `ViewerContext`, `Viewer`, portal RPCs (`InviteViewer`, `ListViewers`, `RevokeViewer`, `ActivateViewer`, `ViewerLogin`), `VerifyTokenResponse.viewer_context` |
| `apps/auth-svc/src/jwt.ts` | Viewer session + single-purpose activation tokens (kind-discriminated) |
| `apps/auth-svc/src/mailer.ts` | New `sendViewerInviteEmail` (link-based, not temp-password copy) |
| `apps/auth-svc/src/service.ts` | New RPC handlers; `signUp` generates an org slug; `verifyToken` branches on token kind |
| `apps/api-gateway/src/auth.ts` | `requireViewer` preHandler, `viewerToInternalContext` helper, exported `extractToken` |
| `apps/api-gateway/src/routes/playback.ts` | Refactor: exported `fetchHlsPlaylist`/`fetchThumbnailUrls`/`presign`/`SIGNED_URL_TTL_SECONDS`, reused by staff and portal routes |
| `apps/api-gateway/src/routes/portal.ts` | New — all `/v1/portal/*` routes |
| `apps/api-gateway/src/routes/assets.ts` | `PATCH /v1/assets/:id/publish` |
| `apps/api-gateway/src/routes/viewers.ts` | New — `/v1/viewers*` staff-facing management routes |
| `apps/api-gateway/src/routes/org.ts` | `PATCH /v1/org` (displayName + logo) |
| `apps/api-gateway/src/main.ts` | Wire `registerPortalRoutes` and `registerViewerRoutes` |

---

### Task 1: Prisma schema, migration, and org slug generation on signup

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260928120000_viewer_portal_and_publishing/migration.sql`
- Modify: `apps/auth-svc/src/service.ts` (`signUp` handler, ~line 135-175)
- Test: `apps/auth-svc/src/service.test.ts`

**Interfaces:**
- Produces: `Org.slug: string` (unique), `Org.displayName: string | null`, `Org.logoStorageKey: string | null`, `Asset.publishedAt: Date | null`, `Viewer` model (`id, orgId, email, passwordHash, invitedAt, activatedAt, revokedAt, createdAt`), `WatchProgress` model (`viewerId, assetId, positionSeconds, updatedAt`) — all consumed by every later task.

- [ ] **Step 1: Edit the Prisma schema**

In `packages/db/prisma/schema.prisma`, modify the `Org` model:

```prisma
model Org {
  id             String       @id @default(cuid())
  name           String
  slug           String       @unique
  displayName    String?
  logoStorageKey String?
  createdAt      DateTime     @default(now())
  users          User[]
  assets         Asset[]
  apiKeys        ApiKey[]
  webhooks       Webhook[]
  auditLog       AuditEvent[]
  viewers        Viewer[]
}
```

Modify the `Asset` model (add one field, one relation, keep everything else):

```prisma
model Asset {
  id               String         @id @default(cuid())
  orgId            String
  org              Org            @relation(fields: [orgId], references: [id])
  title            String
  description      String         @default("")
  status           AssetStatus    @default(UPLOADING)
  sourceStorageKey String?
  sourceBytes      BigInt?
  durationSeconds  Float?
  sourceWidth      Int?
  sourceHeight     Int?
  tags             String[]
  playbackUrl      String?
  thumbnailUrl     String?
  publishedAt      DateTime?
  version          Int            @default(1)
  createdBy        String
  createdAt        DateTime       @default(now())
  updatedAt        DateTime       @updatedAt
  jobs             TranscodeJob[]
  collections      CollectionAsset[]
  watchProgress    WatchProgress[]

  @@index([orgId, status])
  @@index([orgId, createdAt])
}
```

Add two new models at the end of the file:

```prisma
model Viewer {
  id            String          @id @default(cuid())
  orgId         String
  org           Org             @relation(fields: [orgId], references: [id])
  email         String
  passwordHash  String?
  invitedAt     DateTime        @default(now())
  activatedAt   DateTime?
  revokedAt     DateTime?
  createdAt     DateTime        @default(now())
  watchProgress WatchProgress[]

  @@unique([orgId, email])
  @@index([orgId])
}

model WatchProgress {
  viewerId        String
  viewer          Viewer   @relation(fields: [viewerId], references: [id])
  assetId         String
  asset           Asset    @relation(fields: [assetId], references: [id])
  positionSeconds Float
  updatedAt       DateTime @updatedAt

  @@id([viewerId, assetId])
  @@index([viewerId, updatedAt])
}
```

- [ ] **Step 2: Hand-write the migration**

Create `packages/db/prisma/migrations/20260928120000_viewer_portal_and_publishing/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "Asset" ADD COLUMN "publishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Org" ADD COLUMN "slug" TEXT,
ADD COLUMN "displayName" TEXT,
ADD COLUMN "logoStorageKey" TEXT;

-- Backfill: url-safe slug derived from name, with the org id's last 6
-- characters appended so uniqueness never depends on names not colliding.
UPDATE "Org"
SET "slug" = lower(regexp_replace(regexp_replace("name", '[^a-zA-Z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'))
             || '-' || right("id", 6);

ALTER TABLE "Org" ALTER COLUMN "slug" SET NOT NULL;

-- CreateTable
CREATE TABLE "Viewer" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Viewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchProgress" (
    "viewerId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "positionSeconds" DOUBLE PRECISION NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchProgress_pkey" PRIMARY KEY ("viewerId","assetId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Org_slug_key" ON "Org"("slug");

-- CreateIndex
CREATE INDEX "Viewer_orgId_idx" ON "Viewer"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Viewer_orgId_email_key" ON "Viewer"("orgId", "email");

-- CreateIndex
CREATE INDEX "WatchProgress_viewerId_updatedAt_idx" ON "WatchProgress"("viewerId", "updatedAt");

-- AddForeignKey
ALTER TABLE "Viewer" ADD CONSTRAINT "Viewer_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchProgress" ADD CONSTRAINT "WatchProgress_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "Viewer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchProgress" ADD CONSTRAINT "WatchProgress_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply the migration and regenerate the client**

Run: `pnpm --filter @vidforge/db db:deploy && pnpm --filter @vidforge/db db:generate`
Expected: both succeed against the local dev database (start it first if needed — see the `run-dev-stack` skill). `db:generate` produces updated Prisma Client types including `Viewer`/`WatchProgress` and the new `Org`/`Asset` fields.

- [ ] **Step 4: Write the failing test for slug generation on signup**

In `apps/auth-svc/src/service.test.ts`, add:

```ts
describe("signUp org slug", () => {
  it("derives a url-safe slug from the org name", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce(null); // no collision
    vi.mocked(prisma.$transaction).mockImplementationOnce(async (fn) =>
      fn({
        org: { create: vi.fn().mockResolvedValue({ id: "org1", slug: "acme-inc" }) },
        user: {
          create: vi.fn().mockResolvedValue({
            id: "u1", email: "a@b.com", displayName: "A", orgId: "org1", role: "OWNER",
          }),
        },
      } as never),
    );

    const callback = vi.fn();
    const call = {
      request: { email: "a@b.com", password: "smoketestpassword123", displayName: "A", orgName: "Acme, Inc!" },
    } as Parameters<typeof authServiceImpl.signUp>[0];

    await authServiceImpl.signUp(call, callback);

    expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ token: expect.any(String) }));
  });
});
```

Also add `org: { findUnique: vi.fn() }` and `$transaction: vi.fn()` to the `vi.mock("@vidforge/db", ...)` block's `prisma` stub at the top of the file.

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @vidforge/auth-svc test -- -t "derives a url-safe slug"`
Expected: FAIL — `signUp` doesn't yet generate or persist a slug (the mocked `$transaction`/`org.create` aren't wired into the real implementation yet, or the assertion is otherwise unmet).

- [ ] **Step 6: Implement slug generation**

In `apps/auth-svc/src/service.ts`, add near the other small helpers (e.g. after `grpcError`):

```ts
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "") || "org";
}
```

Replace the `signUp` handler's transaction body (inside the `try` block, replacing the existing `const user = await prisma.$transaction(...)`):

```ts
const user = await prisma.$transaction(async (tx) => {
  const orgName = call.request.orgName.trim() || `${displayName.trim()}'s org`;
  const base = slugify(orgName);
  let slug = base;
  let suffix = 0;
  while (await tx.org.findUnique({ where: { slug } })) {
    suffix += 1;
    slug = `${base}-${suffix}`;
  }
  const org = await tx.org.create({ data: { name: orgName, slug } });
  return tx.user.create({
    data: { email, displayName: displayName.trim(), passwordHash, orgId: org.id, role: "OWNER" },
  });
});
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @vidforge/auth-svc test -- -t "derives a url-safe slug"`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260928120000_viewer_portal_and_publishing apps/auth-svc/src/service.ts apps/auth-svc/src/service.test.ts
git commit -m "db: add viewer portal schema (Org.slug, Asset.publishedAt, Viewer, WatchProgress)"
```

---

### Task 2: Proto — viewer identity, portal RPCs, and codegen

**Files:**
- Modify: `packages/proto/src/auth.proto`

**Interfaces:**
- Produces (generated into `packages/proto/gen/auth.ts`, consumed from Task 3 onward): `ViewerContext { viewerId: string; orgId: string }`, `Viewer { viewerId, orgId, email, invitedAt, activatedAt? }`, `AuthServiceServer` now requires `inviteViewer`, `listViewers`, `revokeViewer`, `activateViewer`, `viewerLogin`; `VerifyTokenResponse` gains `viewerContext?: ViewerContext`.

- [ ] **Step 1: Add the `ViewerContext` message and extend `VerifyTokenResponse`**

In `packages/proto/src/auth.proto`, add after the `User` message:

```proto
message ViewerContext {
  string viewer_id = 1;
  string org_id = 2;
}
```

Change `VerifyTokenResponse` (append a new field, don't renumber the existing ones):

```proto
message VerifyTokenResponse {
  bool valid = 1;
  vidforge.common.v1.RequestContext context = 2;
  google.protobuf.Timestamp expires_at = 3;
  ViewerContext viewer_context = 4;
}
```

- [ ] **Step 2: Add the `Viewer` message and portal request/response messages**

Append to `packages/proto/src/auth.proto`:

```proto
message Viewer {
  string viewer_id = 1;
  string org_id = 2;
  string email = 3;
  google.protobuf.Timestamp invited_at = 4;
  google.protobuf.Timestamp activated_at = 5;
}

message InviteViewerRequest {
  vidforge.common.v1.RequestContext context = 1;
  string email = 2;
}

message ListViewersRequest {
  vidforge.common.v1.RequestContext context = 1;
  vidforge.common.v1.PageRequest page = 2;
}

message ListViewersResponse {
  repeated Viewer viewers = 1;
  vidforge.common.v1.PageInfo page_info = 2;
}

message RevokeViewerRequest {
  vidforge.common.v1.RequestContext context = 1;
  string viewer_id = 2;
}

message RevokeViewerResponse {
  bool revoked = 1;
}

message ActivateViewerRequest {
  string org_slug = 1;
  string token = 2;
  string password = 3;
}

message ViewerLoginRequest {
  string org_slug = 1;
  string email = 2;
  string password = 3;
}

message ViewerSessionResponse {
  string token = 1;
  Viewer viewer = 2;
  google.protobuf.Timestamp expires_at = 3;
}
```

- [ ] **Step 3: Add the RPCs to `AuthService`**

In `packages/proto/src/auth.proto`, inside `service AuthService { ... }`, add after `rpc AssignRole(...)`:

```proto
  rpc InviteViewer(InviteViewerRequest) returns (Viewer);
  rpc ListViewers(ListViewersRequest) returns (ListViewersResponse);
  rpc RevokeViewer(RevokeViewerRequest) returns (RevokeViewerResponse);
  rpc ActivateViewer(ActivateViewerRequest) returns (ViewerSessionResponse);
  rpc ViewerLogin(ViewerLoginRequest) returns (ViewerSessionResponse);
```

- [ ] **Step 4: Regenerate TypeScript**

Run: `pnpm --filter @vidforge/proto proto:gen`
Expected: succeeds, regenerating `packages/proto/gen/auth.ts` (and the `index.*` barrel files) with the new messages/RPCs.

- [ ] **Step 5: Typecheck to confirm the generated types are valid**

Run: `pnpm --filter @vidforge/proto typecheck`
Expected: PASS (proto package has no logic of its own to break; this just confirms the generated TS compiles).

- [ ] **Step 6: Commit**

```bash
git add packages/proto/src/auth.proto packages/proto/gen
git commit -m "proto: add ViewerContext, Viewer, and viewer-portal auth RPCs"
```

---

### Task 3: auth-svc — viewer session and activation tokens

**Files:**
- Modify: `apps/auth-svc/src/jwt.ts`
- Test: `apps/auth-svc/src/jwt.test.ts`

**Interfaces:**
- Consumes: `currentSecret()`, `previousSecret()` (existing private helpers in this file).
- Produces: `signViewerToken(claims: {sub, org}): Promise<{token, expiresAt}>`, `signViewerActivationToken(claims: {sub}): Promise<{token, expiresAt}>`, `verifyViewerActivationToken(token): Promise<{sub, exp}>` (throws on invalid/wrong-purpose token), and `verifyJwt`'s return type gains `kind: "staff" | "viewer"` — consumed by Task 6 (`verifyToken`) and Task 5 (`activateViewer`/`viewerLogin`).

- [ ] **Step 1: Write the failing tests**

In `apps/auth-svc/src/jwt.test.ts`, add:

```ts
import { signViewerActivationToken, signViewerToken, verifyViewerActivationToken } from "./jwt.js";

describe("viewer session tokens", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips with kind: viewer, distinguishing it from a staff token", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signViewerToken({ sub: "viewer1", org: "org1" });
    await expect(verifyJwt(token)).resolves.toMatchObject({ sub: "viewer1", org: "org1", kind: "viewer" });
  });
});

describe("viewer activation tokens", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("round-trips and exposes the viewer id as sub", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signViewerActivationToken({ sub: "viewer1" });
    await expect(verifyViewerActivationToken(token)).resolves.toMatchObject({ sub: "viewer1" });
  });

  it("rejects a viewer session token presented as an activation token", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signViewerToken({ sub: "viewer1", org: "org1" });
    await expect(verifyViewerActivationToken(token)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @vidforge/auth-svc test -- jwt.test.ts`
Expected: FAIL — `signViewerToken`/`signViewerActivationToken`/`verifyViewerActivationToken` don't exist yet, and `verifyJwt` doesn't return `kind`.

- [ ] **Step 3: Implement**

In `apps/auth-svc/src/jwt.ts`, change `signToken` to tag staff tokens and `verifyJwt` to surface the `kind` claim:

```ts
export async function signToken(claims: TokenClaims): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 3600_000);
  const token = await new SignJWT({ org: claims.org, role: claims.role, kind: "staff" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(currentSecret());
  return { token, expiresAt };
}

export async function verifyJwt(token: string): Promise<TokenClaims & { exp: number; kind: "staff" | "viewer" }> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, currentSecret()));
  } catch (err) {
    const previous = previousSecret();
    if (!previous) throw err;
    ({ payload } = await jwtVerify(token, previous));
  }
  return {
    sub: payload.sub as string,
    org: payload.org as string,
    role: payload.role as string,
    exp: payload.exp as number,
    kind: (payload.kind as "staff" | "viewer" | undefined) ?? "staff",
  };
}
```

Append below the existing code:

```ts
// Consumer sessions shouldn't force a re-login every 8h the way staff
// sessions do — nobody wants to sign back in mid-movie.
const VIEWER_TOKEN_TTL_HOURS = 24 * 30;
const VIEWER_ACTIVATION_TTL_HOURS = Number(process.env.VIEWER_ACTIVATION_TTL_HOURS ?? 24 * 7);

export interface ViewerTokenClaims {
  sub: string; // viewer id
  org: string; // org id
}

export async function signViewerToken(claims: ViewerTokenClaims): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + VIEWER_TOKEN_TTL_HOURS * 3600_000);
  const token = await new SignJWT({ org: claims.org, kind: "viewer" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(currentSecret());
  return { token, expiresAt };
}

export interface ViewerActivationClaims {
  sub: string; // viewer id
}

export async function signViewerActivationToken(
  claims: ViewerActivationClaims,
): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + VIEWER_ACTIVATION_TTL_HOURS * 3600_000);
  const token = await new SignJWT({ kind: "viewer_activate" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(currentSecret());
  return { token, expiresAt };
}

// Single-purpose: a session token (kind "viewer") must never activate an
// account, and an activation token must never be usable as a session.
export async function verifyViewerActivationToken(
  token: string,
): Promise<ViewerActivationClaims & { exp: number }> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, currentSecret()));
  } catch (err) {
    const previous = previousSecret();
    if (!previous) throw err;
    ({ payload } = await jwtVerify(token, previous));
  }
  if (payload.kind !== "viewer_activate") {
    throw new Error("not an activation token");
  }
  return { sub: payload.sub as string, exp: payload.exp as number };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @vidforge/auth-svc test -- jwt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/auth-svc/src/jwt.ts apps/auth-svc/src/jwt.test.ts
git commit -m "auth-svc: add kind-discriminated viewer session and activation tokens"
```

---

### Task 4: auth-svc — InviteViewer, ListViewers, RevokeViewer

**Files:**
- Modify: `apps/auth-svc/src/mailer.ts`
- Modify: `apps/auth-svc/src/service.ts`
- Test: `apps/auth-svc/src/service.test.ts`

**Interfaces:**
- Consumes: `signViewerActivationToken` (Task 3), `authenticate(ctx)` (existing helper), `ROLE_RANK` (existing).
- Produces: `authServiceImpl.inviteViewer/listViewers/revokeViewer` — consumed by Task 14 (gateway `viewers.ts`).

- [ ] **Step 1: Add the invite email function**

In `apps/auth-svc/src/mailer.ts`, append (this is intentionally separate from `sendInviteEmail`: viewers get a link, not a temporary password, so the copy differs even though both share the same SES transport):

```ts
export async function sendViewerInviteEmail(opts: {
  to: string;
  orgName: string;
  inviterName: string;
  activationUrl: string;
  expiresAt: Date;
}) {
  const hours = Math.round((opts.expiresAt.getTime() - Date.now()) / 3_600_000);
  await getTransport().sendMail({
    from: FROM,
    to: opts.to,
    subject: `You've been invited to watch on ${opts.orgName}`,
    text: [
      `Hi,`,
      ``,
      `${opts.inviterName} invited you to ${opts.orgName}'s video library.`,
      ``,
      `Set up your account: ${opts.activationUrl}`,
      ``,
      `This link expires in ${hours} hours. If it lapses, ask them to invite you again.`,
    ].join("\n"),
  });
}
```

- [ ] **Step 2: Write the failing tests**

In `apps/auth-svc/src/service.test.ts`, add `viewer: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), findMany: vi.fn(), count: vi.fn() }` to the `prisma` stub in the `vi.mock("@vidforge/db", ...)` block, then add:

```ts
import { sendViewerInviteEmail } from "./mailer.js";

vi.mock("./mailer.js", () => ({
  sendInviteEmail: vi.fn(),
  sendViewerInviteEmail: vi.fn(),
}));

const staffCtx = signContext({ userId: "admin1", orgId: "org1", roles: ["ADMIN"], traceId: "t1" });

describe("inviteViewer", () => {
  it("rejects callers below ADMIN", async () => {
    const ctx = signContext({ userId: "u1", orgId: "org1", roles: ["EDITOR"], traceId: "t1" });
    const callback = vi.fn();
    await authServiceImpl.inviteViewer(
      { request: { context: ctx, email: "viewer@example.com" } } as never,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: status.PERMISSION_DENIED }));
  });

  it("creates a pending viewer and emails an activation link", async () => {
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.viewer.create).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", email: "viewer@example.com",
      invitedAt: new Date(), activatedAt: null, revokedAt: null,
    } as never);
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({ id: "org1", name: "Acme", slug: "acme", displayName: null } as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({ id: "admin1", displayName: "Ada Admin" } as never);

    const callback = vi.fn();
    await authServiceImpl.inviteViewer(
      { request: { context: staffCtx, email: "viewer@example.com" } } as never,
      callback,
    );

    expect(sendViewerInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "viewer@example.com", orgName: "Acme" }),
    );
    expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ email: "viewer@example.com" }));
  });

  it("rejects re-inviting an already-activated viewer as a no-op", async () => {
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", email: "viewer@example.com", activatedAt: new Date(),
    } as never);
    const callback = vi.fn();
    await authServiceImpl.inviteViewer(
      { request: { context: staffCtx, email: "viewer@example.com" } } as never,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: status.ALREADY_EXISTS }));
  });
});

describe("revokeViewer", () => {
  it("404s for a viewer in a different org", async () => {
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({ id: "v1", orgId: "org-other" } as never);
    const callback = vi.fn();
    await authServiceImpl.revokeViewer({ request: { context: staffCtx, viewerId: "v1" } } as never, callback);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: status.NOT_FOUND }));
  });

  it("sets revokedAt for a viewer in the caller's org", async () => {
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({ id: "v1", orgId: "org1" } as never);
    vi.mocked(prisma.viewer.update).mockResolvedValueOnce({} as never);
    const callback = vi.fn();
    await authServiceImpl.revokeViewer({ request: { context: staffCtx, viewerId: "v1" } } as never, callback);
    expect(prisma.viewer.update).toHaveBeenCalledWith({
      where: { id: "v1" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(callback).toHaveBeenCalledWith(null, { revoked: true });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @vidforge/auth-svc test -- service.test.ts`
Expected: FAIL — `inviteViewer`/`listViewers`/`revokeViewer` don't exist on `authServiceImpl` yet (TS compile error / runtime `undefined`).

- [ ] **Step 4: Implement**

In `apps/auth-svc/src/service.ts`, add the import and a mapper near `toProtoUser`:

```ts
import { sendInviteEmail, sendViewerInviteEmail } from "./mailer.js";
```

```ts
function toProtoViewer(v: {
  id: string;
  orgId: string;
  email: string;
  invitedAt: Date;
  activatedAt: Date | null;
}) {
  return {
    viewerId: v.id,
    orgId: v.orgId,
    email: v.email,
    invitedAt: v.invitedAt,
    activatedAt: v.activatedAt ?? undefined,
  };
}
```

Add three handlers to the `authServiceImpl` object literal (after `assignRole`):

```ts
inviteViewer: async (call, callback) => {
  const ctx = authenticate(call.request.context);
  if (ctx instanceof Error) return callback(ctx);
  const inviterRank = Math.max(...ctx.roles.map((r) => ROLE_RANK[r] ?? 0), 0);
  if (inviterRank < ROLE_RANK.ADMIN) {
    return callback(grpcError(status.PERMISSION_DENIED, "only admins can invite viewers"));
  }
  const { email } = call.request;
  if (!email.includes("@")) {
    return callback(grpcError(status.INVALID_ARGUMENT, "valid email required"));
  }

  const existing = await prisma.viewer.findUnique({ where: { orgId_email: { orgId: ctx.orgId, email } } });
  if (existing?.activatedAt) {
    return callback(grpcError(status.ALREADY_EXISTS, "this viewer has already activated their account"));
  }
  const viewer = existing
    ? await prisma.viewer.update({ where: { id: existing.id }, data: { invitedAt: new Date(), revokedAt: null } })
    : await prisma.viewer.create({ data: { orgId: ctx.orgId, email } });

  const { token, expiresAt } = await signViewerActivationToken({ sub: viewer.id });
  const [org, inviter] = await Promise.all([
    prisma.org.findUnique({ where: { id: ctx.orgId } }),
    prisma.user.findUnique({ where: { id: ctx.userId } }),
  ]);
  try {
    await sendViewerInviteEmail({
      to: email,
      orgName: org?.displayName || org?.name || "your library",
      inviterName: inviter?.displayName ?? "An admin",
      activationUrl: `${VIEWER_URL}/${org?.slug ?? ""}/activate/${token}`,
      expiresAt,
    });
  } catch (err) {
    return callback(grpcError(status.INTERNAL, `failed to send invite email: ${(err as Error).message}`));
  }
  await prisma.auditEvent.create({
    data: {
      orgId: ctx.orgId, actorUserId: ctx.userId, action: existing ? "viewer.reinvite" : "viewer.invite",
      resourceType: "viewer", resourceId: viewer.id,
    },
  });
  callback(null, toProtoViewer(viewer));
},

listViewers: async (call, callback) => {
  const ctx = authenticate(call.request.context);
  if (ctx instanceof Error) return callback(ctx);
  const pageSize = Math.min(Math.max(call.request.page?.pageSize || 50, 1), 100);
  const pageToken = call.request.page?.pageToken || undefined;
  const [viewers, totalCount] = await Promise.all([
    prisma.viewer.findMany({
      where: { orgId: ctx.orgId },
      orderBy: [{ invitedAt: "desc" }, { id: "desc" }],
      take: pageSize,
      ...(pageToken ? { cursor: { id: pageToken }, skip: 1 } : {}),
    }),
    prisma.viewer.count({ where: { orgId: ctx.orgId } }),
  ]);
  callback(null, {
    viewers: viewers.map(toProtoViewer),
    pageInfo: {
      nextPageToken: viewers.length === pageSize ? viewers[viewers.length - 1].id : "",
      totalCount,
    },
  });
},

revokeViewer: async (call, callback) => {
  const ctx = authenticate(call.request.context);
  if (ctx instanceof Error) return callback(ctx);
  const inviterRank = Math.max(...ctx.roles.map((r) => ROLE_RANK[r] ?? 0), 0);
  if (inviterRank < ROLE_RANK.ADMIN) {
    return callback(grpcError(status.PERMISSION_DENIED, "only admins can revoke viewers"));
  }
  const viewer = await prisma.viewer.findUnique({ where: { id: call.request.viewerId } });
  if (!viewer || viewer.orgId !== ctx.orgId) {
    return callback(grpcError(status.NOT_FOUND, "no such viewer"));
  }
  await prisma.viewer.update({ where: { id: viewer.id }, data: { revokedAt: new Date() } });
  callback(null, { revoked: true });
},
```

Add the `VIEWER_URL` constant near the existing `WEB_URL` constant (top of file):

```ts
const VIEWER_URL = process.env.VIEWER_ORIGIN ?? "http://localhost:3001";
```

Also add `signViewerActivationToken` to the existing `import { signToken, verifyJwt } from "./jwt.js";` line, making it `import { signToken, signViewerActivationToken, verifyJwt } from "./jwt.js";`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @vidforge/auth-svc test -- service.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/auth-svc/src/mailer.ts apps/auth-svc/src/service.ts apps/auth-svc/src/service.test.ts
git commit -m "auth-svc: add InviteViewer, ListViewers, RevokeViewer RPCs"
```

---

### Task 5: auth-svc — ActivateViewer and ViewerLogin

**Files:**
- Modify: `apps/auth-svc/src/service.ts`
- Test: `apps/auth-svc/src/service.test.ts`

**Interfaces:**
- Consumes: `verifyViewerActivationToken`, `signViewerToken` (Task 3), `hashPassword`/`verifyPassword` (existing), `toProtoViewer` (Task 4).
- Produces: `authServiceImpl.activateViewer/viewerLogin` — consumed by Task 8 (gateway `portal.ts`).

- [ ] **Step 1: Write the failing tests**

In `apps/auth-svc/src/service.test.ts`, add:

```ts
describe("activateViewer", () => {
  it("rejects an expired or malformed token", async () => {
    const callback = vi.fn();
    await authServiceImpl.activateViewer(
      { request: { orgSlug: "acme", token: "garbage", password: "longenoughpassword" } } as never,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: status.UNAUTHENTICATED }));
  });

  it("rejects activating an already-activated account", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signViewerActivationToken({ sub: "viewer1" });
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", activatedAt: new Date(), revokedAt: null,
    } as never);
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({ id: "org1", slug: "acme" } as never);

    const callback = vi.fn();
    await authServiceImpl.activateViewer(
      { request: { orgSlug: "acme", token, password: "longenoughpassword" } } as never,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: status.ALREADY_EXISTS }));
  });

  it("activates a pending viewer and returns a session", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signViewerActivationToken({ sub: "viewer1" });
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", activatedAt: null, revokedAt: null,
    } as never);
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({ id: "org1", slug: "acme" } as never);
    vi.mocked(prisma.viewer.update).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", email: "v@example.com", invitedAt: new Date(), activatedAt: new Date(),
    } as never);

    const callback = vi.fn();
    await authServiceImpl.activateViewer(
      { request: { orgSlug: "acme", token, password: "longenoughpassword" } } as never,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ token: expect.any(String) }));
  });
});

describe("viewerLogin", () => {
  it("rejects a revoked viewer even with the correct password", async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({ id: "org1", slug: "acme" } as never);
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", passwordHash: await hashPassword("correcthorsebattery"), revokedAt: new Date(),
    } as never);

    const callback = vi.fn();
    await authServiceImpl.viewerLogin(
      { request: { orgSlug: "acme", email: "v@example.com", password: "correcthorsebattery" } } as never,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ code: status.UNAUTHENTICATED }));
  });

  it("logs in an activated, non-revoked viewer", async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({ id: "org1", slug: "acme" } as never);
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", email: "v@example.com",
      passwordHash: await hashPassword("correcthorsebattery"), revokedAt: null,
      invitedAt: new Date(), activatedAt: new Date(),
    } as never);

    const callback = vi.fn();
    await authServiceImpl.viewerLogin(
      { request: { orgSlug: "acme", email: "v@example.com", password: "correcthorsebattery" } } as never,
      callback,
    );
    expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ token: expect.any(String) }));
  });
});
```

Update the `jwt.js` import to include `signViewerActivationToken` and `signViewerToken`, and `verifyViewerActivationToken` in the top-of-file imports used by the test file (`import { signViewerActivationToken, ... } from "./jwt.js"` — already added by Task 3's own test file; add the same to `service.test.ts`'s imports).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @vidforge/auth-svc test -- service.test.ts`
Expected: FAIL — `activateViewer`/`viewerLogin` don't exist yet.

- [ ] **Step 3: Implement**

In `apps/auth-svc/src/service.ts`, update the `jwt.js` import line to:

```ts
import { signToken, signViewerActivationToken, signViewerToken, verifyJwt, verifyViewerActivationToken } from "./jwt.js";
```

Add two handlers to `authServiceImpl` (after `revokeViewer`):

```ts
activateViewer: async (call, callback) => {
  const { orgSlug, token, password } = call.request;
  if (password.length < 8) {
    return callback(grpcError(status.INVALID_ARGUMENT, "password must be at least 8 characters"));
  }
  let claims;
  try {
    claims = await verifyViewerActivationToken(token);
  } catch {
    return callback(grpcError(status.UNAUTHENTICATED, "invalid or expired invite link"));
  }
  const [viewer, org] = await Promise.all([
    prisma.viewer.findUnique({ where: { id: claims.sub } }),
    prisma.org.findUnique({ where: { slug: orgSlug } }),
  ]);
  if (!viewer || !org || viewer.orgId !== org.id) {
    return callback(grpcError(status.NOT_FOUND, "no such invite"));
  }
  if (viewer.revokedAt) {
    return callback(grpcError(status.PERMISSION_DENIED, "this invite has been revoked"));
  }
  if (viewer.activatedAt) {
    return callback(grpcError(status.ALREADY_EXISTS, "this account is already activated — sign in instead"));
  }
  const passwordHash = await hashPassword(password);
  const activated = await prisma.viewer.update({
    where: { id: viewer.id },
    data: { passwordHash, activatedAt: new Date() },
  });
  const { token: sessionToken, expiresAt } = await signViewerToken({ sub: activated.id, org: activated.orgId });
  callback(null, { token: sessionToken, viewer: toProtoViewer(activated), expiresAt });
},

viewerLogin: async (call, callback) => {
  try {
    const { orgSlug, email, password } = call.request;
    const org = await prisma.org.findUnique({ where: { slug: orgSlug } });
    if (!org) {
      return callback(grpcError(status.UNAUTHENTICATED, "invalid email or password"));
    }
    const viewer = await prisma.viewer.findUnique({ where: { orgId_email: { orgId: org.id, email } } });
    if (!viewer?.passwordHash || viewer.revokedAt || !(await verifyPassword(password, viewer.passwordHash))) {
      return callback(grpcError(status.UNAUTHENTICATED, "invalid email or password"));
    }
    const { token, expiresAt } = await signViewerToken({ sub: viewer.id, org: viewer.orgId });
    callback(null, { token, viewer: toProtoViewer(viewer), expiresAt });
  } catch (err) {
    callback(grpcError(status.INTERNAL, `login failed: ${(err as Error).message}`));
  }
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @vidforge/auth-svc test -- service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/auth-svc/src/service.ts apps/auth-svc/src/service.test.ts
git commit -m "auth-svc: add ActivateViewer and ViewerLogin RPCs"
```

---

### Task 6: auth-svc — VerifyToken returns ViewerContext for viewer tokens

**Files:**
- Modify: `apps/auth-svc/src/service.ts`
- Test: `apps/auth-svc/src/service.test.ts`

**Interfaces:**
- Consumes: `verifyJwt`'s `kind` field (Task 3).
- Produces: `VerifyTokenResponse.viewerContext` populated correctly — consumed by Task 7 (gateway `requireViewer`).

- [ ] **Step 1: Write the failing tests**

In `apps/auth-svc/src/service.test.ts`, add:

```ts
describe("verifyToken — viewer tokens", () => {
  it("returns a ViewerContext, never a staff context, for a viewer token", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signViewerToken({ sub: "viewer1", org: "org1" });
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", activatedAt: new Date(), revokedAt: null,
    } as never);

    const callback = vi.fn();
    await authServiceImpl.verifyToken({ request: { token } } as never, callback);

    expect(callback).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ valid: true, context: undefined, viewerContext: { viewerId: "viewer1", orgId: "org1" } }),
    );
  });

  it("rejects a viewer token for a viewer that no longer exists", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signViewerToken({ sub: "viewer1", org: "org1" });
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce(null);

    const callback = vi.fn();
    await authServiceImpl.verifyToken({ request: { token } } as never, callback);

    expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ valid: false }));
  });

  it("rejects an already-issued session token the instant the viewer is revoked — revocation isn't just a login-time check", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signViewerToken({ sub: "viewer1", org: "org1" });
    vi.mocked(prisma.viewer.findUnique).mockResolvedValueOnce({
      id: "viewer1", orgId: "org1", activatedAt: new Date("2026-01-01"), revokedAt: new Date("2026-09-28"),
    } as never);

    const callback = vi.fn();
    await authServiceImpl.verifyToken({ request: { token } } as never, callback);

    expect(callback).toHaveBeenCalledWith(null, expect.objectContaining({ valid: false }));
  });

  it("a staff token never resolves to a ViewerContext (cross-contamination guard)", async () => {
    vi.stubEnv("JWT_SECRET", "current-secret");
    const { token } = await signToken({ sub: "user1", org: "org1", role: "ADMIN" });
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: "user1", orgId: "org1", role: "ADMIN", mustChangePassword: false,
    } as never);

    const callback = vi.fn();
    await authServiceImpl.verifyToken({ request: { token } } as never, callback);

    const [, res] = callback.mock.calls[0];
    expect(res.viewerContext).toBeUndefined();
    expect(res.context).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @vidforge/auth-svc test -- service.test.ts`
Expected: FAIL — `verifyToken` doesn't branch on `kind` yet, so a viewer token falls into the staff `prisma.user.findUnique` path and returns `valid: false` (wrong reason) or an undefined `viewerContext` field mismatch.

- [ ] **Step 3: Implement**

In `apps/auth-svc/src/service.ts`, replace the `verifyToken` handler's JWT branch (the `try { const claims = await verifyJwt(...) ... } catch {...}` block, lines ~107-132) with:

```ts
try {
  const claims = await verifyJwt(call.request.token);
  if (claims.kind === "viewer") {
    const viewer = await prisma.viewer.findUnique({ where: { id: claims.sub } });
    if (!viewer || !viewer.activatedAt || viewer.revokedAt) {
      return callback(null, { valid: false, context: undefined, viewerContext: undefined, expiresAt: undefined });
    }
    return callback(null, {
      valid: true,
      context: undefined,
      viewerContext: { viewerId: viewer.id, orgId: viewer.orgId },
      expiresAt: new Date(claims.exp * 1000),
    });
  }
  // Role and org come fresh from the DB, not the token, so role
  // changes and deleted users take effect within a token's lifetime.
  const user = await prisma.user.findUnique({ where: { id: claims.sub } });
  // A user on a temporary password has no business holding a session:
  // any token from before the invite (or a leak) is rejected here.
  if (!user || user.mustChangePassword) {
    return callback(null, { valid: false, context: undefined, viewerContext: undefined, expiresAt: undefined });
  }
  callback(null, {
    valid: true,
    context: {
      userId: user.id,
      orgId: user.orgId,
      roles: [user.role],
      traceId: "",
      // The gateway signs the context after attaching its trace id.
      issuedAtMs: 0,
      signature: "",
    },
    viewerContext: undefined,
    expiresAt: new Date(claims.exp * 1000),
  });
} catch {
  callback(null, { valid: false, context: undefined, viewerContext: undefined, expiresAt: undefined });
}
```

Also add `viewerContext: undefined` to the two API-key-branch `callback(null, { valid: false, context: undefined, expiresAt: undefined })` calls earlier in the same handler, for consistent response shape.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @vidforge/auth-svc test -- service.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full auth-svc suite**

Run: `pnpm --filter @vidforge/auth-svc test`
Expected: PASS (no regressions in existing staff-token tests).

- [ ] **Step 6: Commit**

```bash
git add apps/auth-svc/src/service.ts apps/auth-svc/src/service.test.ts
git commit -m "auth-svc: VerifyToken returns ViewerContext for viewer tokens"
```

---

### Task 7: gateway — requireViewer preHandler

**Files:**
- Modify: `apps/api-gateway/src/auth.ts`
- Test: `apps/api-gateway/src/auth.test.ts` (new)

**Interfaces:**
- Consumes: `signContext` (existing, from `@vidforge/svc-auth`), `ViewerContext` type (Task 2, `@vidforge/proto/auth`).
- Produces: `requireViewer(): preHandlerHookHandler` (sets `req.viewerContext`), `viewerToInternalContext(viewer, traceId): RequestContext`, exported `extractToken` — all consumed by Task 8/11/12 (`portal.ts`).

- [ ] **Step 1: Write the failing tests**

Create `apps/api-gateway/src/auth.test.ts`:

```ts
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("@vidforge/proto/auth", () => ({
  AuthServiceClient: vi.fn().mockImplementation(() => ({
    verifyToken: vi.fn((_req, cb) => cb(null, { valid: false, context: undefined, viewerContext: undefined })),
  })),
}));

import { authClient, requireViewer, viewerToInternalContext } from "./auth.js";

describe("requireViewer", () => {
  it("401s when VerifyToken returns no viewerContext (e.g. a staff token)", async () => {
    vi.mocked(authClient.verifyToken).mockImplementationOnce((_req, cb) =>
      cb(null, { valid: true, context: { userId: "u1", orgId: "org1", roles: ["ADMIN"] }, viewerContext: undefined } as never),
    );
    const app = Fastify();
    app.get("/protected", { preHandler: requireViewer() }, async () => ({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/protected", headers: { authorization: "Bearer staff-token" } });
    expect(res.statusCode).toBe(401);
  });

  it("sets req.viewerContext when VerifyToken returns one", async () => {
    vi.mocked(authClient.verifyToken).mockImplementationOnce((_req, cb) =>
      cb(null, { valid: true, context: undefined, viewerContext: { viewerId: "v1", orgId: "org1" } } as never),
    );
    const app = Fastify();
    app.get("/protected", { preHandler: requireViewer() }, async (req) => ({ viewer: req.viewerContext }));
    const res = await app.inject({ method: "GET", url: "/protected", headers: { authorization: "Bearer viewer-token" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ viewer: { viewerId: "v1", orgId: "org1" } });
  });
});

describe("viewerToInternalContext", () => {
  it("produces a signed RequestContext scoped to the viewer's org with the lowest staff rank", () => {
    vi.stubEnv("CONTEXT_SIGNING_SECRET", "test-secret");
    const ctx = viewerToInternalContext({ viewerId: "v1", orgId: "org1" }, "trace1");
    expect(ctx).toMatchObject({ userId: "v1", orgId: "org1", roles: ["VIEWER"], traceId: "trace1" });
    expect(ctx.signature).toBeTruthy();
    vi.unstubAllEnvs();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @vidforge/api-gateway test -- auth.test.ts`
Expected: FAIL — `requireViewer`/`viewerToInternalContext` don't exist yet.

- [ ] **Step 3: Implement**

In `apps/api-gateway/src/auth.ts`, change `function extractToken` to `export function extractToken`, add a new import line directly below the existing `import type { RequestContext } from "@vidforge/proto/common";` (leave that line unchanged — `RequestContext` is generated from `common.proto`, `ViewerContext` from `auth.proto`, exported via the package's separate `"./common"`/`"./auth"` entry points), augment the Fastify module declaration, and append the new exports:

```ts
import type { ViewerContext } from "@vidforge/proto/auth";
```

```ts
declare module "fastify" {
  interface FastifyRequest {
    authContext?: RequestContext;
    viewerContext?: ViewerContext;
  }
}
```

```ts
function verifyViewer(token: string): Promise<ViewerContext | null> {
  return new Promise((resolve) => {
    authClient.verifyToken({ token }, (err, res) => {
      if (err || !res.valid || !res.viewerContext) return resolve(null);
      resolve(res.viewerContext);
    });
  });
}

export function requireViewer(): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = extractToken(req);
    if (!token) return reply.code(401).send({ error: "missing bearer token" });
    const viewerContext = await verifyViewer(token);
    if (!viewerContext) return reply.code(401).send({ error: "invalid or expired token" });
    req.viewerContext = viewerContext;
  };
}

// The portal reuses staff-facing internal gRPC calls (e.g. video-svc's
// GetOutputManifest), which expect a signed RequestContext. A viewer has no
// staff role, so we synthesize the lowest one (VIEWER) scoped to their own
// org — enough for the existing org-ownership checks downstream, without
// giving video-svc (or any other internal service) any notion of "viewer."
export function viewerToInternalContext(viewer: ViewerContext, traceId: string): RequestContext {
  return signContext({ userId: viewer.viewerId, orgId: viewer.orgId, roles: ["VIEWER"], traceId });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @vidforge/api-gateway test -- auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api-gateway/src/auth.ts apps/api-gateway/src/auth.test.ts
git commit -m "gateway: add requireViewer preHandler and viewerToInternalContext"
```

---

### Task 8: gateway — portal.ts scaffold: org branding, activate, login

**Files:**
- Create: `apps/api-gateway/src/routes/portal.ts`
- Modify: `apps/api-gateway/src/main.ts`
- Test: `apps/api-gateway/src/routes/portal.test.ts` (new)

**Interfaces:**
- Consumes: `authClient` (existing, from `../auth.js`), `presign` (Task 9 — forward reference; stub this task's org-branding route against it and let Task 9 supply the real export).
- Produces: `registerPortalRoutes(app, videoClient)` — extended by Tasks 11 and 12 in the same file/function.

- [ ] **Step 1: Write the failing tests**

Create `apps/api-gateway/src/routes/portal.test.ts`:

```ts
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("@vidforge/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vidforge/db")>();
  return { ...actual, prisma: { ...actual.prisma, org: { findUnique: vi.fn() } } };
});

vi.mock("../auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth.js")>();
  return { ...actual, authClient: { activateViewer: vi.fn(), viewerLogin: vi.fn() } };
});

vi.mock("./playback.js", () => ({ presign: vi.fn().mockResolvedValue("https://signed.example/logo.png") }));

import { prisma } from "@vidforge/db";
import { authClient } from "../auth.js";
import { registerPortalRoutes } from "./portal.js";

function buildApp() {
  const app = Fastify();
  registerPortalRoutes(app, {} as never);
  return app;
}

describe("GET /v1/portal/org/:orgSlug", () => {
  it("404s for an unknown slug", async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/portal/org/nope" });
    expect(res.statusCode).toBe(404);
  });

  it("returns displayName (falling back to name) and a presigned logo URL", async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({
      displayName: null, name: "Acme", logoStorageKey: "org-logos/x.png",
    } as never);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/portal/org/acme" });
    expect(res.json()).toEqual({ displayName: "Acme", logoUrl: "https://signed.example/logo.png" });
  });
});

describe("POST /v1/portal/auth/login", () => {
  it("validates the body", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/portal/auth/login", payload: { orgSlug: "acme" } });
    expect(res.statusCode).toBe(400);
  });

  it("forwards to ViewerLogin and maps UNAUTHENTICATED to 401", async () => {
    vi.mocked(authClient.viewerLogin).mockImplementationOnce((_req, cb) =>
      cb(Object.assign(new Error("bad"), { code: 16, details: "invalid email or password" }), undefined as never),
    );
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/portal/auth/login",
      payload: { orgSlug: "acme", email: "a@b.com", password: "x" },
    });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @vidforge/api-gateway test -- portal.test.ts`
Expected: FAIL — `./portal.js` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/api-gateway/src/routes/portal.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@vidforge/db";
import type { VideoServiceClient } from "@vidforge/proto/video";
import { authClient } from "../auth.js";
import { presign } from "./playback.js";

const activateSchema = z.object({
  orgSlug: z.string().min(1),
  token: z.string().min(1),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  orgSlug: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(1),
});

const GRPC_HTTP: Record<number, number> = { 3: 400, 5: 404, 6: 409, 7: 403, 16: 401 };

const LIMITS = {
  login: { max: 10, timeWindow: "1 minute" },
  activate: { max: 10, timeWindow: "15 minutes" },
} as const;

function rateLimited(limit: { max: number; timeWindow: string }) {
  return {
    rateLimit: {
      ...limit,
      errorResponseBuilder: (_req: unknown, ctx: { ttl: number }) => ({
        statusCode: 429,
        error: `too many attempts, retry in ${Math.ceil(ctx.ttl / 1000)}s`,
      }),
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- consumed by Task 11/12
export function registerPortalRoutes(app: FastifyInstance, videoClient: VideoServiceClient) {
  app.get("/v1/portal/org/:orgSlug", async (req, reply) => {
    const { orgSlug } = req.params as { orgSlug: string };
    const org = await prisma.org.findUnique({
      where: { slug: orgSlug },
      select: { displayName: true, name: true, logoStorageKey: true },
    });
    if (!org) return reply.code(404).send({ error: "no such org" });
    return reply.send({
      displayName: org.displayName || org.name,
      logoUrl: org.logoStorageKey ? await presign(org.logoStorageKey) : null,
    });
  });

  app.post("/v1/portal/auth/activate", { config: rateLimited(LIMITS.activate) }, async (req, reply) => {
    const parsed = activateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return new Promise((resolve) => {
      authClient.activateViewer(parsed.data, (err, res) => {
        if (err) {
          resolve(reply.code(GRPC_HTTP[err.code] ?? 502).send({ error: err.details || err.message }));
        } else {
          resolve(reply.send(res));
        }
      });
    });
  });

  app.post("/v1/portal/auth/login", { config: rateLimited(LIMITS.login) }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return new Promise((resolve) => {
      authClient.viewerLogin(parsed.data, (err, res) => {
        if (err) {
          resolve(reply.code(GRPC_HTTP[err.code] ?? 502).send({ error: err.details || err.message }));
        } else {
          resolve(reply.send(res));
        }
      });
    });
  });
}
```

In `apps/api-gateway/src/main.ts`, add the import near the other route imports:

```ts
import { registerPortalRoutes } from "./routes/portal.js";
```

Add the call in the registration block (after `registerAssetRoutes(app);`):

```ts
registerPortalRoutes(app, videoClient);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @vidforge/api-gateway test -- portal.test.ts`
Expected: PASS (the `presign` mock stands in for Task 9's real export — this file imports it now but Task 9 must land before the app can actually boot against real S3).

- [ ] **Step 5: Commit**

```bash
git add apps/api-gateway/src/routes/portal.ts apps/api-gateway/src/routes/portal.test.ts apps/api-gateway/src/main.ts
git commit -m "gateway: add portal org-branding, activate, and login routes"
```

---

### Task 9: gateway — extract shared playback logic from playback.ts

**Files:**
- Modify: `apps/api-gateway/src/routes/playback.ts`
- Test: `apps/api-gateway/src/routes/playback.test.ts` (new)

**Interfaces:**
- Produces: `export function fetchHlsPlaylist(videoClient, context: RequestContext, jobId, rest): Promise<HlsPlaylistResult | PlaybackError>`, `export function fetchThumbnailUrls(videoClient, context, jobId): Promise<string[]>`, `export const presign: (key: string) => Promise<string>`, `export const SIGNED_URL_TTL_SECONDS: number` — consumed by Task 8 (already, via `presign`) and Task 11 (portal hls/thumbnails routes).

- [ ] **Step 1: Write the failing tests**

Create `apps/api-gateway/src/routes/playback.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: vi.fn().mockResolvedValue({ Body: undefined }) })),
  GetObjectCommand: vi.fn(),
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://signed.example/x"),
}));
vi.mock("../playlist.js", () => ({ rewritePlaylist: vi.fn().mockResolvedValue("#EXTM3U rewritten") }));

import { fetchHlsPlaylist, fetchThumbnailUrls } from "./playback.js";

const ctx = { userId: "u1", orgId: "org1", roles: ["VIEWER"], traceId: "t1", issuedAtMs: 0, signature: "" } as never;

describe("fetchHlsPlaylist", () => {
  it("rejects non-m3u8 paths", async () => {
    const result = await fetchHlsPlaylist({} as never, ctx, "job1", "segment.ts");
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("rejects path traversal", async () => {
    const result = await fetchHlsPlaylist({} as never, ctx, "job1", "../../etc/passwd.m3u8");
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("404s when the job has no output manifest", async () => {
    const videoClient = { getOutputManifest: vi.fn((_req, cb) => cb(new Error("not found"), undefined)) };
    const result = await fetchHlsPlaylist(videoClient as never, ctx, "job1", "master.m3u8");
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("returns the rewritten playlist on success", async () => {
    const videoClient = {
      getOutputManifest: vi.fn((_req, cb) => cb(null, { playlistStorageKey: "jobs/job1/master.m3u8" })),
    };
    const result = await fetchHlsPlaylist(videoClient as never, ctx, "job1", "master.m3u8");
    expect(result).toMatchObject({ ok: true, body: "#EXTM3U rewritten" });
  });
});

describe("fetchThumbnailUrls", () => {
  it("returns an empty array when there's no manifest", async () => {
    const videoClient = { getOutputManifest: vi.fn((_req, cb) => cb(new Error("nope"), undefined)) };
    await expect(fetchThumbnailUrls(videoClient as never, ctx, "job1")).resolves.toEqual([]);
  });

  it("presigns every thumbnail key", async () => {
    const videoClient = {
      getOutputManifest: vi.fn((_req, cb) => cb(null, { thumbnailStorageKeys: ["a.jpg", "b.jpg"] })),
    };
    await expect(fetchThumbnailUrls(videoClient as never, ctx, "job1")).resolves.toEqual([
      "https://signed.example/x",
      "https://signed.example/x",
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @vidforge/api-gateway test -- playback.test.ts`
Expected: FAIL — `fetchHlsPlaylist`/`fetchThumbnailUrls` aren't exported yet.

- [ ] **Step 3: Implement**

Replace the body of `apps/api-gateway/src/routes/playback.ts` from `const SIGNED_URL_TTL_SECONDS = 900;` down through the end of `registerPlaybackRoutes` with:

```ts
export const SIGNED_URL_TTL_SECONDS = 900;

const s3 = new S3Client(resolveS3Config());
const s3Public = new S3Client(resolveS3Config(process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT));

async function readBody(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export const presign = (key: string) =>
  getSignedUrl(s3Public, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: SIGNED_URL_TTL_SECONDS,
  });

export type HlsPlaylistResult = {
  ok: true;
  body: string;
  contentType: string;
  cacheControl: string;
};
export type PlaybackError = { ok: false; status: number; error: string };

// Shared by the staff (`/v1/jobs/...`) and portal (`/v1/portal/jobs/...`)
// routes: the manifest fetch, presign, and playlist rewrite are identical —
// only the RequestContext passed in (and, for the portal, an extra publish
// check the caller does before calling this) differs.
export async function fetchHlsPlaylist(
  videoClient: VideoServiceClient,
  context: RequestContext,
  jobId: string,
  rest: string,
): Promise<HlsPlaylistResult | PlaybackError> {
  if (!rest.endsWith(".m3u8")) {
    return { ok: false, status: 404, error: "media is served via signed URLs, not the gateway" };
  }
  if (rest.includes("..") || rest.includes("//")) {
    return { ok: false, status: 400, error: "invalid path" };
  }

  const manifest = await new Promise<{ playlistStorageKey: string } | null>((resolve) => {
    videoClient.getOutputManifest({ context, jobId }, (err, res) => resolve(err ? null : res));
  });
  if (!manifest) {
    return { ok: false, status: 404, error: "no playable output for this job" };
  }

  const prefix = manifest.playlistStorageKey.replace(/master\.m3u8$/, "");
  const key = `${prefix}${rest}`;
  const keyDir = key.slice(0, key.lastIndexOf("/") + 1);

  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const rewritten = await rewritePlaylist(await readBody(obj.Body as Readable), keyDir, presign);
    return {
      ok: true,
      body: rewritten,
      contentType: "application/vnd.apple.mpegurl",
      cacheControl: `private, max-age=${SIGNED_URL_TTL_SECONDS - 60}`,
    };
  } catch {
    return { ok: false, status: 404, error: "playlist not found" };
  }
}

export async function fetchThumbnailUrls(
  videoClient: VideoServiceClient,
  context: RequestContext,
  jobId: string,
): Promise<string[]> {
  const manifest = await new Promise<{ thumbnailStorageKeys: string[] } | null>((resolve) => {
    videoClient.getOutputManifest({ context, jobId }, (err, res) => resolve(err ? null : res));
  });
  const keys = manifest?.thumbnailStorageKeys ?? [];
  return Promise.all(keys.map((key) => presign(key)));
}

export function registerPlaybackRoutes(app: FastifyInstance, videoClient: VideoServiceClient) {
  app.get("/v1/jobs/:jobId/hls/*", { preHandler: requireRole("VIEWER") }, async (req, reply) => {
    const { jobId, "*": rest } = req.params as { jobId: string; "*": string };
    const result = await fetchHlsPlaylist(videoClient, req.authContext!, jobId, rest);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    reply.header("content-type", result.contentType);
    reply.header("cache-control", result.cacheControl);
    return reply.send(result.body);
  });

  app.get("/v1/jobs/:jobId/thumbnails", { preHandler: requireRole("VIEWER") }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    reply.header("cache-control", `private, max-age=${SIGNED_URL_TTL_SECONDS - 60}`);
    const thumbnails = await fetchThumbnailUrls(videoClient, req.authContext!, jobId);
    return reply.send({ thumbnails });
  });
}
```

Add `RequestContext` to the existing type-only import at the top of the file: `import type { RequestContext } from "@vidforge/proto/common";`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @vidforge/api-gateway test -- playback.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full gateway suite to confirm no regression**

Run: `pnpm --filter @vidforge/api-gateway test`
Expected: PASS, including Task 8's `portal.test.ts` (which mocked `./playback.js` — now safe to leave mocked or, optionally, un-mock and rely on this task's real `presign`; either is fine since the mock only affects that one test file).

- [ ] **Step 6: Commit**

```bash
git add apps/api-gateway/src/routes/playback.ts apps/api-gateway/src/routes/playback.test.ts
git commit -m "gateway: extract fetchHlsPlaylist/fetchThumbnailUrls for reuse by the portal routes"
```

---

### Task 10: gateway — PATCH /v1/assets/:id/publish

**Files:**
- Modify: `apps/api-gateway/src/routes/assets.ts`
- Test: `apps/api-gateway/src/routes/assets.test.ts`

**Interfaces:**
- Produces: `PATCH /v1/assets/:id/publish` (EDITOR+) — sets/clears `Asset.publishedAt`, consumed by Task 11's library filter and the follow-up frontend plan's publish toggle.

- [ ] **Step 1: Write the failing tests**

In `apps/api-gateway/src/routes/assets.test.ts`, add (reusing the file's existing `vi.mock` setup — extend the `prisma.asset` stub with `findFirst` and `update: vi.fn()`):

```ts
describe("PATCH /v1/assets/:id/publish", () => {
  it("404s for an asset in a different org", async () => {
    vi.mocked(prisma.asset.findFirst).mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await app.inject({
      method: "PATCH", url: "/v1/assets/a1/publish", payload: { published: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("sets publishedAt when publishing", async () => {
    vi.mocked(prisma.asset.findFirst).mockResolvedValueOnce({ id: "a1", orgId: "org-1" } as never);
    vi.mocked(prisma.asset.update).mockResolvedValueOnce({ id: "a1", publishedAt: new Date("2026-09-28") } as never);
    const app = buildApp();
    const res = await app.inject({
      method: "PATCH", url: "/v1/assets/a1/publish", payload: { published: true },
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { publishedAt: expect.any(Date) } });
  });

  it("clears publishedAt when unpublishing", async () => {
    vi.mocked(prisma.asset.findFirst).mockResolvedValueOnce({ id: "a1", orgId: "org-1" } as never);
    vi.mocked(prisma.asset.update).mockResolvedValueOnce({ id: "a1", publishedAt: null } as never);
    const app = buildApp();
    await app.inject({ method: "PATCH", url: "/v1/assets/a1/publish", payload: { published: false } });
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { publishedAt: null } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @vidforge/api-gateway test -- assets.test.ts`
Expected: FAIL — the route doesn't exist yet.

- [ ] **Step 3: Implement**

In `apps/api-gateway/src/routes/assets.ts`, add `import { z } from "zod";` at the top, and add a route inside `registerAssetRoutes` (after the existing `GET /v1/assets` handler):

```ts
const publishSchema = z.object({ published: z.boolean() });

app.patch("/v1/assets/:id/publish", { preHandler: requireRole("EDITOR") }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const parsed = publishSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const asset = await prisma.asset.findFirst({ where: { id, orgId: req.authContext!.orgId } });
  if (!asset) return reply.code(404).send({ error: "no such asset" });
  const updated = await prisma.asset.update({
    where: { id },
    data: { publishedAt: parsed.data.published ? new Date() : null },
  });
  return reply.send({ assetId: updated.id, publishedAt: updated.publishedAt });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @vidforge/api-gateway test -- assets.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api-gateway/src/routes/assets.ts apps/api-gateway/src/routes/assets.test.ts
git commit -m "gateway: add PATCH /v1/assets/:id/publish"
```

---

### Task 11: gateway — portal library, hls, and thumbnails routes

**Files:**
- Modify: `apps/api-gateway/src/routes/portal.ts`
- Modify: `apps/api-gateway/src/routes/portal.test.ts`

**Interfaces:**
- Consumes: `fetchHlsPlaylist`/`fetchThumbnailUrls`/`SIGNED_URL_TTL_SECONDS` (Task 9), `requireViewer`/`viewerToInternalContext` (Task 7).
- Produces: `GET /v1/portal/library`, `GET /v1/portal/jobs/:jobId/hls/*`, `GET /v1/portal/jobs/:jobId/thumbnails`.

- [ ] **Step 1: Write the failing tests**

In `apps/api-gateway/src/routes/portal.test.ts`, extend the `@vidforge/db` mock to include `asset: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn() }`, extend the `../auth.js` mock to stub `requireViewer: () => async (req: { viewerContext?: unknown }) => { req.viewerContext = { viewerId: "v1", orgId: "org1" }; }` and `viewerToInternalContext: () => ({ userId: "v1", orgId: "org1", roles: ["VIEWER"], traceId: "t", issuedAtMs: 0, signature: "s" })`, and mock `./playback.js`'s `fetchHlsPlaylist`/`fetchThumbnailUrls` alongside the existing `presign` mock. Then add:

```ts
describe("GET /v1/portal/library", () => {
  it("only returns published assets, scoped to the viewer's org", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.asset.count).mockResolvedValueOnce(0);
    const app = buildApp();
    await app.inject({ method: "GET", url: "/v1/portal/library" });
    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ orgId: "org1", publishedAt: { not: null } }),
      }),
    );
  });

  it("filters by title when q is given", async () => {
    vi.mocked(prisma.asset.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.asset.count).mockResolvedValueOnce(0);
    const app = buildApp();
    await app.inject({ method: "GET", url: "/v1/portal/library?q=dragon" });
    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ title: { contains: "dragon", mode: "insensitive" } }),
      }),
    );
  });
});

describe("GET /v1/portal/jobs/:jobId/hls/*", () => {
  it("404s when the job's asset isn't published in the viewer's org", async () => {
    vi.mocked(prisma.transcodeJob.findFirst).mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/portal/jobs/job1/hls/master.m3u8" });
    expect(res.statusCode).toBe(404);
  });
});
```

Add `transcodeJob: { findFirst: vi.fn() }` to the `prisma` mock stub.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @vidforge/api-gateway test -- portal.test.ts`
Expected: FAIL — the routes don't exist yet.

- [ ] **Step 3: Implement**

In `apps/api-gateway/src/routes/portal.ts`, add imports:

```ts
import { fetchHlsPlaylist, fetchThumbnailUrls, SIGNED_URL_TTL_SECONDS } from "./playback.js";
import { requireViewer, viewerToInternalContext } from "../auth.js";
```

Add inside `registerPortalRoutes`, after the existing routes:

```ts
app.get("/v1/portal/library", { preHandler: requireViewer() }, async (req, reply) => {
  const { pageSize, pageToken, q } = req.query as { pageSize?: string; pageToken?: string; q?: string };
  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 100);
  const where = {
    orgId: req.viewerContext!.orgId,
    publishedAt: { not: null },
    ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}),
  };
  const [assets, totalCount] = await Promise.all([
    prisma.asset.findMany({
      where,
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      take: size,
      ...(pageToken ? { cursor: { id: pageToken }, skip: 1 } : {}),
      include: {
        jobs: { where: { state: "COMPLETED" }, orderBy: { finishedAt: "desc" }, take: 1, select: { id: true } },
      },
    }),
    prisma.asset.count({ where }),
  ]);
  return reply.send({
    assets: assets.map((a) => ({
      assetId: a.id,
      title: a.title,
      durationSeconds: a.durationSeconds,
      latestCompletedJobId: a.jobs[0]?.id ?? null,
    })),
    pageInfo: { nextPageToken: assets.length === size ? assets[assets.length - 1].id : "", totalCount },
  });
});

// Playback is additionally gated on the asset being published — video-svc's
// GetOutputManifest only knows about org ownership, not publish state, so
// that check happens here before we ever call it.
async function requirePublishedJob(orgId: string, jobId: string): Promise<boolean> {
  const job = await prisma.transcodeJob.findFirst({
    where: { id: jobId, orgId, asset: { publishedAt: { not: null } } },
    select: { id: true },
  });
  return job !== null;
}

app.get("/v1/portal/jobs/:jobId/hls/*", { preHandler: requireViewer() }, async (req, reply) => {
  const { jobId, "*": rest } = req.params as { jobId: string; "*": string };
  const viewer = req.viewerContext!;
  if (!(await requirePublishedJob(viewer.orgId, jobId))) {
    return reply.code(404).send({ error: "no playable output for this job" });
  }
  const context = viewerToInternalContext(viewer, req.id);
  const result = await fetchHlsPlaylist(videoClient, context, jobId, rest);
  if (!result.ok) return reply.code(result.status).send({ error: result.error });
  reply.header("content-type", result.contentType);
  reply.header("cache-control", result.cacheControl);
  return reply.send(result.body);
});

app.get("/v1/portal/jobs/:jobId/thumbnails", { preHandler: requireViewer() }, async (req, reply) => {
  const { jobId } = req.params as { jobId: string };
  const viewer = req.viewerContext!;
  reply.header("cache-control", `private, max-age=${SIGNED_URL_TTL_SECONDS - 60}`);
  if (!(await requirePublishedJob(viewer.orgId, jobId))) {
    return reply.send({ thumbnails: [] });
  }
  const context = viewerToInternalContext(viewer, req.id);
  const thumbnails = await fetchThumbnailUrls(videoClient, context, jobId);
  return reply.send({ thumbnails });
});
```

Remove the now-unnecessary `// eslint-disable-next-line ... unused-vars` comment above `registerPortalRoutes` from Task 8, since `videoClient` is used now.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @vidforge/api-gateway test -- portal.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api-gateway/src/routes/portal.ts apps/api-gateway/src/routes/portal.test.ts
git commit -m "gateway: add portal library, hls, and thumbnails routes"
```

---

### Task 12: gateway — portal progress and history routes

**Files:**
- Modify: `apps/api-gateway/src/routes/portal.ts`
- Modify: `apps/api-gateway/src/routes/portal.test.ts`

**Interfaces:**
- Produces: `GET /v1/portal/progress`, `PUT /v1/portal/progress/:assetId`, `GET /v1/portal/history`.

- [ ] **Step 1: Write the failing tests**

In `apps/api-gateway/src/routes/portal.test.ts`, add `watchProgress: { findMany: vi.fn(), upsert: vi.fn() }` to the `prisma` mock stub, then:

```ts
describe("PUT /v1/portal/progress/:assetId", () => {
  it("404s for an asset outside the viewer's org", async () => {
    vi.mocked(prisma.asset.findFirst).mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await app.inject({
      method: "PUT", url: "/v1/portal/progress/a1", payload: { positionSeconds: 42 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("upserts progress keyed by viewer and asset", async () => {
    vi.mocked(prisma.asset.findFirst).mockResolvedValueOnce({ id: "a1", orgId: "org1" } as never);
    vi.mocked(prisma.watchProgress.upsert).mockResolvedValueOnce({
      viewerId: "v1", assetId: "a1", positionSeconds: 42, updatedAt: new Date(),
    } as never);
    const app = buildApp();
    const res = await app.inject({
      method: "PUT", url: "/v1/portal/progress/a1", payload: { positionSeconds: 42 },
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.watchProgress.upsert).toHaveBeenCalledWith({
      where: { viewerId_assetId: { viewerId: "v1", assetId: "a1" } },
      create: { viewerId: "v1", assetId: "a1", positionSeconds: 42 },
      update: { positionSeconds: 42 },
    });
  });
});

describe("GET /v1/portal/history", () => {
  it("marks unpublished assets as unavailable but still lists them", async () => {
    vi.mocked(prisma.watchProgress.findMany).mockResolvedValueOnce([
      {
        assetId: "a1", positionSeconds: 10, updatedAt: new Date(),
        asset: { title: "Gone", publishedAt: null, jobs: [] },
      },
    ] as never);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/portal/history" });
    expect(res.json()).toMatchObject({ history: [expect.objectContaining({ available: false })] });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @vidforge/api-gateway test -- portal.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Add `import { z } from "zod";` to `apps/api-gateway/src/routes/portal.ts`'s imports. Add inside `registerPortalRoutes`, after the hls/thumbnails routes:

```ts
app.get("/v1/portal/progress", { preHandler: requireViewer() }, async (req, reply) => {
  const rows = await prisma.watchProgress.findMany({
    where: { viewerId: req.viewerContext!.viewerId },
    orderBy: { updatedAt: "desc" },
  });
  return reply.send({
    progress: rows.map((r) => ({ assetId: r.assetId, positionSeconds: r.positionSeconds, updatedAt: r.updatedAt })),
  });
});

const progressSchema = z.object({ positionSeconds: z.number().min(0) });

app.put("/v1/portal/progress/:assetId", { preHandler: requireViewer() }, async (req, reply) => {
  const { assetId } = req.params as { assetId: string };
  const parsed = progressSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const viewer = req.viewerContext!;
  const asset = await prisma.asset.findFirst({ where: { id: assetId, orgId: viewer.orgId } });
  if (!asset) return reply.code(404).send({ error: "no such asset" });
  const row = await prisma.watchProgress.upsert({
    where: { viewerId_assetId: { viewerId: viewer.viewerId, assetId } },
    create: { viewerId: viewer.viewerId, assetId, positionSeconds: parsed.data.positionSeconds },
    update: { positionSeconds: parsed.data.positionSeconds },
  });
  return reply.send({ assetId: row.assetId, positionSeconds: row.positionSeconds, updatedAt: row.updatedAt });
});

app.get("/v1/portal/history", { preHandler: requireViewer() }, async (req, reply) => {
  const rows = await prisma.watchProgress.findMany({
    where: { viewerId: req.viewerContext!.viewerId },
    orderBy: { updatedAt: "desc" },
    include: {
      asset: {
        select: {
          title: true, publishedAt: true,
          jobs: { where: { state: "COMPLETED" }, orderBy: { finishedAt: "desc" }, take: 1, select: { id: true } },
        },
      },
    },
  });
  return reply.send({
    history: rows.map((r) => ({
      assetId: r.assetId,
      title: r.asset.title,
      positionSeconds: r.positionSeconds,
      updatedAt: r.updatedAt,
      available: r.asset.publishedAt !== null,
      latestCompletedJobId: r.asset.jobs[0]?.id ?? null,
    })),
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @vidforge/api-gateway test -- portal.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api-gateway/src/routes/portal.ts apps/api-gateway/src/routes/portal.test.ts
git commit -m "gateway: add portal progress and history routes"
```

---

### Task 13: gateway — viewer management routes (invite/list/revoke)

**Files:**
- Create: `apps/api-gateway/src/routes/viewers.ts`
- Create: `apps/api-gateway/src/routes/viewers.test.ts`
- Modify: `apps/api-gateway/src/main.ts`

**Interfaces:**
- Consumes: `authClient.inviteViewer/listViewers/revokeViewer` (Task 4), `requireRole` (existing).
- Produces: `POST /v1/viewers/invite`, `GET /v1/viewers`, `POST /v1/viewers/:viewerId/revoke` — consumed by the follow-up frontend plan's Viewers panel.

- [ ] **Step 1: Write the failing tests**

Create `apps/api-gateway/src/routes/viewers.test.ts`:

```ts
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("../auth.js", () => ({
  authClient: { inviteViewer: vi.fn(), listViewers: vi.fn(), revokeViewer: vi.fn() },
  requireRole: () => async (req: { authContext?: unknown }) => {
    req.authContext = { orgId: "org-1", userId: "admin-1", roles: ["ADMIN"] };
  },
}));

import { authClient } from "../auth.js";
import { registerViewerRoutes } from "./viewers.js";

function buildApp() {
  const app = Fastify();
  registerViewerRoutes(app);
  return app;
}

describe("POST /v1/viewers/invite", () => {
  it("validates the email", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/viewers/invite", payload: { email: "not-an-email" } });
    expect(res.statusCode).toBe(400);
  });

  it("forwards to InviteViewer and returns 201 on success", async () => {
    vi.mocked(authClient.inviteViewer).mockImplementationOnce((_req, cb) =>
      cb(null, { viewerId: "v1", orgId: "org-1", email: "v@example.com" } as never),
    );
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/viewers/invite", payload: { email: "v@example.com" } });
    expect(res.statusCode).toBe(201);
  });

  it("maps ALREADY_EXISTS (re-inviting an activated viewer) to 409", async () => {
    vi.mocked(authClient.inviteViewer).mockImplementationOnce((_req, cb) =>
      cb(Object.assign(new Error("x"), { code: 6, details: "already activated" }), undefined as never),
    );
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/viewers/invite", payload: { email: "v@example.com" } });
    expect(res.statusCode).toBe(409);
  });
});

describe("POST /v1/viewers/:viewerId/revoke", () => {
  it("maps NOT_FOUND to 404", async () => {
    vi.mocked(authClient.revokeViewer).mockImplementationOnce((_req, cb) =>
      cb(Object.assign(new Error("x"), { code: 5, details: "no such viewer" }), undefined as never),
    );
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/viewers/v1/revoke" });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @vidforge/api-gateway test -- viewers.test.ts`
Expected: FAIL — `./viewers.js` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/api-gateway/src/routes/viewers.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authClient, requireRole } from "../auth.js";

const inviteSchema = z.object({ email: z.string().email() });

const LIMITS = { invite: { max: 30, timeWindow: "1 hour" } } as const;

function rateLimited(limit: { max: number; timeWindow: string }) {
  return {
    rateLimit: {
      ...limit,
      errorResponseBuilder: (_req: unknown, ctx: { ttl: number }) => ({
        statusCode: 429,
        error: `too many attempts, retry in ${Math.ceil(ctx.ttl / 1000)}s`,
      }),
    },
  };
}

export function registerViewerRoutes(app: FastifyInstance) {
  app.post(
    "/v1/viewers/invite",
    { preHandler: requireRole("ADMIN"), config: rateLimited(LIMITS.invite) },
    async (req, reply) => {
      const parsed = inviteSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      return new Promise((resolve) => {
        authClient.inviteViewer({ context: req.authContext!, email: parsed.data.email }, (err, res) => {
          if (err) {
            const code = err.code === 7 ? 403 : err.code === 6 ? 409 : err.code === 3 ? 400 : 502;
            resolve(reply.code(code).send({ error: err.details || err.message }));
          } else {
            resolve(reply.code(201).send(res));
          }
        });
      });
    },
  );

  app.get("/v1/viewers", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    return new Promise((resolve) => {
      authClient.listViewers({ context: req.authContext!, page: { pageSize: 100, pageToken: "" } }, (err, res) => {
        if (err) {
          resolve(reply.code(502).send({ error: err.details || err.message }));
        } else {
          resolve(reply.send(res));
        }
      });
    });
  });

  app.post("/v1/viewers/:viewerId/revoke", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
    const { viewerId } = req.params as { viewerId: string };
    return new Promise((resolve) => {
      authClient.revokeViewer({ context: req.authContext!, viewerId }, (err, res) => {
        if (err) {
          const code = err.code === 5 ? 404 : 502;
          resolve(reply.code(code).send({ error: err.details || err.message }));
        } else {
          resolve(reply.send(res));
        }
      });
    });
  });
}
```

In `apps/api-gateway/src/main.ts`, add the import and registration call:

```ts
import { registerViewerRoutes } from "./routes/viewers.js";
```

```ts
registerViewerRoutes(app);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @vidforge/api-gateway test -- viewers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api-gateway/src/routes/viewers.ts apps/api-gateway/src/routes/viewers.test.ts apps/api-gateway/src/main.ts
git commit -m "gateway: add viewer invite/list/revoke management routes"
```

---

### Task 14: gateway — org branding (displayName + logo)

**Files:**
- Modify: `apps/api-gateway/src/routes/org.ts`
- Modify: `apps/api-gateway/src/routes/org.test.ts` (create if it doesn't already exist — none was found in the directory listing, so create it)

**Interfaces:**
- Produces: `PATCH /v1/org` (ADMIN+) — sets `Org.displayName`/`Org.logoStorageKey`, consumed by Task 8's `GET /v1/portal/org/:orgSlug` and the follow-up frontend plan's org identity form.

- [ ] **Step 1: Write the failing tests**

Create `apps/api-gateway/src/routes/org.test.ts`:

```ts
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

vi.mock("@vidforge/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vidforge/db")>();
  return { ...actual, prisma: { ...actual.prisma, org: { update: vi.fn() } } };
});

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: vi.fn().mockResolvedValue({}) })),
  PutObjectCommand: vi.fn(),
}));

vi.mock("../auth.js", () => ({
  authClient: {},
  requireRole: () => async (req: { authContext?: unknown }) => {
    req.authContext = { orgId: "org-1", userId: "admin-1", roles: ["ADMIN"] };
  },
}));

import { prisma } from "@vidforge/db";
import { registerOrgRoutes } from "./org.js";

function buildApp() {
  const app = Fastify();
  registerOrgRoutes(app);
  return app;
}

describe("PATCH /v1/org", () => {
  it("updates displayName alone", async () => {
    vi.mocked(prisma.org.update).mockResolvedValueOnce({ displayName: "Acme Streaming", logoStorageKey: null } as never);
    const app = buildApp();
    const res = await app.inject({ method: "PATCH", url: "/v1/org", payload: { displayName: "Acme Streaming" } });
    expect(res.statusCode).toBe(200);
    expect(prisma.org.update).toHaveBeenCalledWith({ where: { id: "org-1" }, data: { displayName: "Acme Streaming" } });
  });

  it("rejects a non-image data URI for the logo", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "PATCH", url: "/v1/org", payload: { logoDataUri: "data:text/plain;base64,aGVsbG8=" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a logo over 2MB", async () => {
    const bigBase64 = Buffer.alloc(3 * 1024 * 1024, 1).toString("base64");
    const app = buildApp();
    const res = await app.inject({
      method: "PATCH", url: "/v1/org", payload: { logoDataUri: `data:image/png;base64,${bigBase64}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @vidforge/api-gateway test -- org.test.ts`
Expected: FAIL — `PATCH /v1/org` doesn't exist yet.

- [ ] **Step 3: Implement**

In `apps/api-gateway/src/routes/org.ts`, add imports at the top:

```ts
import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { prisma } from "@vidforge/db";
import { resolveS3Config } from "../s3-config.js";
```

Add near the top of the file, alongside the other schemas:

```ts
const BUCKET = process.env.S3_BUCKET ?? "vidforge-media";
const s3 = new S3Client(resolveS3Config());

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg" };

const identitySchema = z.object({
  displayName: z.string().max(80).optional(),
  // A small data: URI, not a resumable upload: the tus/S3Store path exists
  // for large video files, which a single org logo isn't — this is
  // simpler and good enough for a v1 branding field.
  logoDataUri: z.string().optional(),
});
```

Add a route inside `registerOrgRoutes` (after `/v1/org/audit`, before the API key routes):

```ts
app.patch("/v1/org", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
  const parsed = identitySchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const data: { displayName?: string; logoStorageKey?: string } = {};
  if (parsed.data.displayName !== undefined) data.displayName = parsed.data.displayName;
  if (parsed.data.logoDataUri) {
    const match = /^data:(image\/(?:png|jpeg|svg\+xml));base64,(.+)$/.exec(parsed.data.logoDataUri);
    const ext = match ? LOGO_MIME[match[1]] : undefined;
    if (!ext) return reply.code(400).send({ error: "logo must be a PNG, JPEG or SVG data URI" });
    const buffer = Buffer.from(match![2], "base64");
    if (buffer.byteLength > MAX_LOGO_BYTES) {
      return reply.code(400).send({ error: "logo must be under 2MB" });
    }
    const key = `org-logos/${req.authContext!.orgId}-${randomUUID()}.${ext}`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: match![1] }));
    data.logoStorageKey = key;
  }
  const org = await prisma.org.update({ where: { id: req.authContext!.orgId }, data });
  return reply.send({ displayName: org.displayName, logoStorageKey: org.logoStorageKey });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @vidforge/api-gateway test -- org.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full gateway suite**

Run: `pnpm --filter @vidforge/api-gateway test`
Expected: PASS across all route test files (assets, org, portal, playback, viewers, config, playlist, s3-config).

- [ ] **Step 6: Commit**

```bash
git add apps/api-gateway/src/routes/org.ts apps/api-gateway/src/routes/org.test.ts
git commit -m "gateway: add PATCH /v1/org for portal displayName and logo"
```

---

### Task 15: repo-wide verification

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS across every workspace package, including `@vidforge/proto`'s regenerated types flowing correctly into `auth-svc` and `api-gateway`.

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: PASS — every package's vitest suite, including the new/updated ones from Tasks 1–14.

- [ ] **Step 3: Drift check**

Run: `SHADOW_DATABASE_URL=<local shadow db url> pnpm db:drift-check`
Expected: PASS — Task 1's hand-written `migration.sql` produces the same end state as `schema.prisma`. If this fails, the migration SQL and the schema have diverged — fix the SQL, don't hand-edit the schema to match a mistake in the SQL.

- [ ] **Step 4: Commit** (only if any of the above required fixes)

```bash
git add -A
git commit -m "fix: address typecheck/test/drift-check findings from full verification pass"
```
