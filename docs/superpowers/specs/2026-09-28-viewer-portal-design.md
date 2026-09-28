# Viewer portal — an OTT-style companion app for published video libraries

Status: approved design, not yet planned/implemented.

## Context

VidForge's only client today is `apps/web`, an admin/ops dashboard for org
staff (upload, transcode, jobs, API keys, org settings). It has no
consumer-style "browse and watch" experience — the closest thing is a bare
`/watch/[jobId]` page reachable only by direct link.

This spec adds a second, separate product: a white-label, OTT-style
companion web app that an org's *own customers* (not org staff) use to
browse a curated library of that org's videos and watch them with adaptive
(HLS) streaming. This is a deliberate exception to the 2026-06-12 feature
freeze, made explicitly for this work.

Most of the underlying plumbing already exists and this design reuses it:

- Adaptive HLS playback: `apps/api-gateway/src/routes/playback.ts` serves
  presigned-segment playlists behind CloudFront; `apps/web/components/Player.tsx`
  already does ABR level switching via hls.js.
- A library-shaped read path: `GET /v1/assets` (org-scoped, paginated).
- Thumbnails/poster art: already generated and served.
- Org-scoped multi-tenancy and role-based staff auth (`Role`: VIEWER →
  EDITOR → ADMIN → OWNER), enforced via signed `RequestContext` propagated
  from the gateway to internal gRPC services (`packages/svc-auth`).

## Goals

- Org staff can publish/unpublish individual assets to their org's viewer
  portal from the existing admin dashboard (`apps/web`).
- Org's own customers ("viewers") get their own accounts, scoped to one org,
  created via an admin-issued invite.
- Viewers get a Netflix-style flat library (grid, title search), can play
  published videos with adaptive streaming, get resume/continue-watching,
  and a watch history.
- The portal shows minimal per-org branding (name + logo).

## Non-goals (v1)

- Collections/rows/categories (existing `Collection` model stays unused;
  flat library only).
- Full theming or custom domains.
- Native mobile/TV clients (backend design doesn't preclude them later, but
  nothing here is built for them specifically).
- Any change to the existing staff `User`/`Role` model or its permissions.

## Architecture

A new Next.js app, `apps/viewer`, is added to the monorepo alongside
`apps/web`. It is a separate deployable with its own auth/session, but talks
to the **existing** `apps/api-gateway` and `apps/auth-svc` rather than new
services — a new route group (`/v1/portal/*`) is added to each, reusing the
S3/HLS/presigning code already in `playback.ts`.

Viewer identity is **structurally separate** from staff identity, not a new
value on the existing `Role` enum. A viewer JWT carries `{ kind: "viewer",
viewerId, orgId }` and `VerifyToken` returns a distinct `ViewerContext` for
it, never a staff `RequestContext`. The gateway's new `requireViewer`
preHandler only accepts a `ViewerContext`; the existing `requireRole` only
accepts a staff `RequestContext`. This means a viewer token cannot satisfy a
staff-only route (or vice versa) through a role-comparison mistake — the two
token types are incompatible by construction, matching the existing
context-signing package's approach to preventing forged/confused contexts.

This was chosen over two alternatives:

- **Adding a new low `Role` to the existing `User` model** — less new code,
  but blends "org staff hierarchy" and "org's external customers" into one
  enum/table. Given org data isolation is already a load-bearing security
  property in this codebase, a customer-facing account boundary deserves a
  stronger guarantee than "the role check is written correctly everywhere."
- **A fully separate portal service** (own gRPC service + gateway, matching
  the `jobs-svc`/`metadata-svc` pattern) — cleanest long-term isolation, but
  real new infra (task definition, Cloud Map entry, ECR repo) to stand up
  right after the 2026-09-25 AWS teardown, for what's mostly a read-only
  veneer over assets that already exist. Worth revisiting if the portal
  outgrows the shared gateway.

## Data model

New Prisma models and fields (all additive migrations, no destructive
changes to existing tables):

```
model Org {
  // ...existing fields...
  slug         String  @unique   // url-safe, generated from name at creation;
                                  // backfilled for existing orgs by the migration
  displayName  String?           // portal header; falls back to `name`
  logoStorageKey String?
}

model Asset {
  // ...existing fields...
  publishedAt  DateTime?         // null = not visible in any viewer portal
}

model Viewer {
  id           String    @id @default(cuid())
  orgId        String
  org          Org       @relation(fields: [orgId], references: [id])
  email        String
  passwordHash String?
  invitedAt    DateTime  @default(now())
  activatedAt  DateTime?
  createdAt    DateTime  @default(now())

  @@unique([orgId, email])
  @@index([orgId])
}

model WatchProgress {
  viewerId       String
  viewer         Viewer  @relation(fields: [viewerId], references: [id])
  assetId        String
  asset          Asset   @relation(fields: [assetId], references: [id])
  positionSeconds Float
  updatedAt      DateTime @updatedAt

  @@id([viewerId, assetId])
  @@index([viewerId, updatedAt])
}
```

`Org.slug` exists because `Viewer.email` is only unique *within* an org
(the same person could be a customer of two different VidForge orgs), so
login needs an org to disambiguate. The portal is reached at a per-org path
keyed by slug (e.g. `/:orgSlug/login`), and login/activate requests include
it.

Watch history is `WatchProgress` rows ordered by `updatedAt desc` — no
separate history table.

## Viewer auth flow

1. **Invite:** an EDITOR+ in `apps/web` enters a viewer's email on the new
   org "Viewers" panel → `InviteViewer` RPC (auth-svc) creates a `Viewer`
   row (`activatedAt: null`) and emails an activation link via the existing
   SES path, containing a signed, time-limited, single-purpose token (not a
   password). Re-inviting an un-activated viewer rotates/resends the token
   (mirrors `InviteUser`'s existing temp-password-rotate behavior);
   re-inviting an activated viewer is rejected as a no-op.
2. **Activate:** the viewer opens the link in `apps/viewer` →
   `POST /v1/portal/auth/activate` (`{orgSlug, token, password}`) →
   `ActivateViewer` RPC sets `passwordHash`/`activatedAt`, returns a viewer
   session.
3. **Login:** `POST /v1/portal/auth/login` (`{orgSlug, email, password}`) →
   `ViewerLogin` RPC → viewer JWT. Rate-limited the same way staff login is.
4. **Token verification:** `VerifyToken` recognizes the viewer JWT's `kind`
   claim and returns a `ViewerContext { viewerId, orgId }` instead of a
   staff `RequestContext`.

## API surface

New routes on the existing `apps/api-gateway`, under `/v1/portal/*`:

| Route | Auth | Notes |
|---|---|---|
| `POST /v1/portal/auth/activate` | public | consumes invite token |
| `POST /v1/portal/auth/login` | public | rate-limited |
| `GET /v1/portal/library` | viewer | same cursor-pagination shape as `/v1/assets`, filtered to `publishedAt != null`, plus `q` (title, case-insensitive `ILIKE`) |
| `GET /v1/portal/jobs/:jobId/hls/*` | viewer | wraps existing playlist/presigning logic; additionally requires the job's asset to be published and in the viewer's org |
| `GET /v1/portal/jobs/:jobId/thumbnails` | viewer | same wrapping |
| `GET /v1/portal/progress` | viewer | bulk fetch, powers "Continue watching" |
| `PUT /v1/portal/progress/:assetId` | viewer | `{positionSeconds}`, upserts; client calls every ~10s + on pause/unload |
| `GET /v1/portal/history` | viewer | `WatchProgress` joined to asset title/poster, `updatedAt desc`; not filtered by published state (it's a record of what happened), but replay still goes through the publish check |

Refactor: `playback.ts`'s manifest-fetch/presign/rewrite logic is extracted
into shared functions parameterized by an "authorization check" callback, so
the staff routes and the new portal routes share the S3/HLS code rather than
forking it.

New routes on `apps/web`'s existing surface:

- `PATCH /v1/assets/:id/publish` (`{published: boolean}`, EDITOR+) — powers
  a toggle on `AssetsBoard.tsx`.
- `POST /v1/viewers/invite` (`{email}`, ADMIN+) and a list/revoke pair,
  surfaced as a new "Viewers" panel on the org settings page.
- Org logo upload + `displayName` field, next to the existing org name
  setting.

## `apps/viewer` (new app)

Same stack as `apps/web` (Next.js 15, Tailwind, hls.js), separate workspace
package, separate deployable, separate session storage (not shared with
`apps/web`'s).

Pages: `/:orgSlug/login`, `/:orgSlug/activate/[token]`, `/:orgSlug` (library
grid — poster art from existing thumbnails, search box, "Continue watching"
row), `/:orgSlug/watch/[assetId]` (player + periodic progress `PUT`),
`/:orgSlug/history`.

`Player.tsx` is **duplicated** into `apps/viewer` rather than extracted into
a shared package for v1: the two apps' token wiring differs (staff bearer
vs. viewer bearer), and the component is small. Extracting a shared package
across two consumers for ~100 lines is premature; revisit if a future
client (e.g. native) makes the duplication actually cost something.

Root layout resolves the org by slug and renders `displayName`/logo in the
header in place of "VidForge".

## Error handling / edge cases

- **Unpublish while watching:** the portal playback route re-checks
  `publishedAt` on every manifest fetch (same per-request pattern as the
  existing org-ownership check), so access cuts off within one manifest
  refresh — segments already presigned to the client remain valid for the
  existing TTL window, same as today's behavior for revoked staff access.
- **Re-inviting a viewer:** see Auth flow above.
- **Watch history after unpublish:** shown, but replay is blocked by the
  same publish check; UI shows "no longer available."
- **Rate limiting:** `/v1/portal/auth/*` reuses the existing gateway
  rate-limit middleware.

## Testing

- auth-svc: unit tests for `InviteViewer`/`ActivateViewer`/`ViewerLogin`,
  viewer-token verification, org-slug disambiguation, token expiry.
- api-gateway: `requireViewer` rejects staff tokens and vice versa;
  `/v1/portal/library` returns only published + org-scoped assets; portal
  playback blocked for unpublished or foreign-org jobs.
- Migration: additive only, via `pnpm db:migrate` (CI's `db:drift-check`
  already enforces this repo-wide) — includes the `Org.slug` backfill for
  existing rows.
- `apps/viewer`: component-level tests for library/search/progress logic,
  matching `apps/web`'s existing vitest setup.
