# Viewer Portal — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `apps/web` UI additions (publish toggle, Viewers panel, org branding form) and the new `apps/viewer` Next.js app, so org staff can manage the viewer portal from the existing dashboard and an org's own customers can activate, log in, browse, and watch published videos with resume/history.

**Architecture:** `apps/viewer` is a new, separate Next.js 15 workspace package — same stack as `apps/web` (Tailwind, hls.js, `@vercel/otel`), same fully-client-rendered idiom (no server-side data fetching to the gateway; `apps/web` has none today, so this plan doesn't introduce a new pattern). It talks to the **existing** `apps/api-gateway` `/v1/portal/*` routes (already implemented — see `docs/superpowers/plans/2026-09-28-viewer-portal-backend.md`), reached at per-org paths (`/:orgSlug/...`). Session storage is **scoped per `orgSlug`** (`vidforge.viewer.token.<orgSlug>` etc., not a single global key like `apps/web`'s `vidforge.token`) — a single browser can hold separate viewer sessions for two different orgs' portals without either one clobbering or leaking into the other. `Player.tsx` is duplicated into `apps/viewer` (per spec: too small to be worth a shared package, and the two apps' token wiring differs). A single `portalFetch` helper centralizes the "on 401, clear this org's session and redirect to its login page" behavior so every protected page gets automatic session-revocation handling for free, without repeating the logic.

**Tech Stack:** Next.js 15, React 19, Tailwind CSS 3, hls.js, `@vercel/otel`, vitest. No new dependencies beyond what `apps/web` already uses.

**Spec:** `docs/superpowers/specs/2026-09-28-viewer-portal-design.md`

**Depends on:** `docs/superpowers/plans/2026-09-28-viewer-portal-backend.md` (merged to `main`) — every route this plan's frontend calls already exists, except one small addition (`GET /v1/org`, Task 3 below) needed so the org branding form has something to read on load.

## Global Constraints

- No new services/infra: `apps/viewer` reuses the existing `apps/api-gateway`/`apps/auth-svc` `/v1/portal/*` surface. Adding a `viewer` block to `docker-compose.prod.yml` (local compose only) is in scope; adding new Terraform (an `ecs-viewer.tf`, Cloud Map entry, ECR repo) is **not** — that's a real-infra deploy step for whenever the team next stands AWS back up (torn down 2026-09-25), not part of building the app.
- v1 scope only: flat library (no Collections/rows), no theming/custom domains, no native clients. Don't build toward these.
- Never touch the existing staff `User`/`Role` model, `apps/web`'s session storage keys, or its permission checks.
- Viewer session storage is per-`orgSlug` and structurally separate from `apps/web`'s (`vidforge.viewer.*` key prefix vs. `apps/web`'s `vidforge.*`) — this is load-bearing, not cosmetic (see Review Focus #1).
- `PUT /v1/portal/progress/:assetId` is called roughly every 10s during playback plus once on pause/unload, per spec — don't call it on every `timeupdate` event (fires ~4×/second).
- Match `apps/web`'s existing conventions exactly: fully client-rendered pages (`"use client"`), Tailwind utility classes inline (no CSS modules, no component library), `localStorage` for session state, the `if (!mounted) return null` hydration-flash guard, `fetch` + manual `authHeaders()` (no data-fetching library).

## Review Focus

- **Cross-org session bleed:** a viewer logged into `orgA`'s portal who navigates (or is sent a link) to `orgB`'s portal must land on `orgB`'s login page, never see `orgA`'s library/session under `orgB`'s branding. Pins the per-`orgSlug` session-scoping design — this is the single most important property in this plan.
- **Revoked mid-session:** a viewer whose account is revoked by an admin while they still hold an unexpired browser session must be redirected to login the moment their next API call 401s, not left on a stale library grid or an infinite spinner.
- **Re-opening a stale/used activation link:** a viewer who re-opens an old activation email (already activated, or a second invite superseded it) must see a clear "already activated — sign in instead" message, not a raw error or a broken form.
- **Deep-linking to an unpublished/removed asset's watch page:** navigating to `/watch/[assetId]` for an asset that's been unpublished (or whose playable job changed) since the page that linked here last fetched must show a clear "no longer available" state, never a broken player or blank video element.
- **Progress-reporting throttle:** the watch page must not call `PUT /v1/portal/progress/:assetId` on every `timeupdate` tick — it must throttle to the spec's ~10s cadence, while still flushing once on pause/unload so a short viewing session isn't silently lost.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/lib/api.ts` | Add `publishedAt` to `Asset`; add `Viewer`, `OrgIdentity` types |
| `apps/web/components/AssetsBoard.tsx` | Publish/unpublish toggle per asset |
| `apps/web/components/ViewersPanel.tsx` | New — invite/list/revoke viewers |
| `apps/web/components/OrgBrandingPanel.tsx` | New — org display name + logo upload |
| `apps/api-gateway/src/routes/org.ts` | New `GET /v1/org` (ADMIN+) so the branding form has something to load |
| `apps/web/app/org/page.tsx` | Wire in `ViewersPanel` and `OrgBrandingPanel` |
| `apps/viewer/package.json`, `next.config.ts`, `tsconfig.json`, `tailwind.config.ts`, `postcss.config.mjs`, `Dockerfile`, `instrumentation.ts` | New app scaffold, mirrors `apps/web` |
| `apps/viewer/app/layout.tsx` | Root HTML shell |
| `apps/viewer/app/globals.css` | Tailwind directives |
| `apps/viewer/lib/session.ts` | Pure per-org localStorage key/read/write helpers |
| `apps/viewer/lib/api.ts` | `GATEWAY_URL`, types, `portalFetch` (401 → clear session + redirect) |
| `apps/viewer/lib/library.ts` | Pure "continue watching" selection helper |
| `apps/viewer/lib/progress.ts` | Pure progress-report throttle helper |
| `apps/viewer/app/[orgSlug]/layout.tsx` | Client layout: fetches org branding, renders header |
| `apps/viewer/app/[orgSlug]/login/page.tsx` | Login form |
| `apps/viewer/app/[orgSlug]/activate/[token]/page.tsx` | Activation form |
| `apps/viewer/app/[orgSlug]/page.tsx` | Library grid, search, continue-watching row |
| `apps/viewer/components/Player.tsx` | Duplicated/adapted HLS player with progress reporting |
| `apps/viewer/app/[orgSlug]/watch/[assetId]/page.tsx` | Watch page |
| `apps/viewer/app/[orgSlug]/history/page.tsx` | History page |
| `docker-compose.prod.yml` | New `viewer` service (build + port 3101) |
| `.claude/skills/run-dev-stack/apps.sh`, `SKILL.md` | Add `apps/viewer` to the dev-stack app list/port checks |

---

### Task 1: apps/web — publish/unpublish toggle

**Files:**
- Modify: `apps/web/lib/api.ts`
- Modify: `apps/web/components/AssetsBoard.tsx`

**Interfaces:**
- Consumes: `PATCH /v1/assets/:id/publish` (`{published: boolean}` → `{assetId, publishedAt}`), `GET /v1/assets` (now returns `publishedAt: string | null` per asset — already shipped by the backend plan).
- Produces: `Asset.publishedAt: string | null` — consumed by nothing else in this plan, but is the field the toggle reads/writes.

This task has no new pure logic to TDD (it's a fetch call wired to a button, following the exact pattern `AssetsBoard.tsx`'s existing `transcode()` function already uses) — `apps/web` has no component-test precedent to extend (its two existing test files cover pure `lib/` functions only, per `apps/web/lib/parseInvites.test.ts`). Verify by typecheck and, if you have the dev stack running (`run-dev-stack` skill), by clicking the toggle.

- [ ] **Step 1: Add `publishedAt` to the `Asset` type**

In `apps/web/lib/api.ts`, in the `Asset` interface (after `latestCompletedJobId`):

```ts
export interface Asset {
  assetId: string;
  title: string;
  status: "UPLOADING" | "UPLOADED" | "PROCESSING" | "READY" | "FAILED" | "ARCHIVED";
  sourceStorageKey: string | null;
  sourceBytes: number | null;
  durationSeconds: number | null;
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
  latestCompletedJobId: string | null;
}
```

- [ ] **Step 2: Add the toggle handler**

In `apps/web/components/AssetsBoard.tsx`, add a new function after `transcode`:

```ts
async function togglePublish(asset: Asset) {
  setError(null);
  const res = await fetch(`${GATEWAY_URL}/v1/assets/${asset.assetId}/publish`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ published: !asset.publishedAt }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    setError(typeof body?.error === "string" ? body.error : `publish toggle failed: ${res.status}`);
    return;
  }
  await refresh();
}
```

- [ ] **Step 3: Add the column**

In `apps/web/components/AssetsBoard.tsx`'s `<thead>`, add a header after "Status":

```tsx
<th className="px-4 py-2.5 font-medium">Portal</th>
```

In the `<tbody>` row, add a cell after the status `<td>` (before the "Size" `<td>`):

```tsx
<td className="px-4 py-3">
  {canEdit ? (
    <button
      onClick={() => void togglePublish(a)}
      className={`rounded px-2 py-1 text-xs font-medium ${
        a.publishedAt
          ? "bg-emerald-950 text-emerald-400 hover:bg-emerald-900"
          : "bg-slate-800 text-slate-400 hover:bg-slate-700"
      }`}
    >
      {a.publishedAt ? "Published" : "Unpublished"}
    </button>
  ) : (
    <span className={`text-xs ${a.publishedAt ? "text-emerald-400" : "text-slate-500"}`}>
      {a.publishedAt ? "Published" : "Unpublished"}
    </span>
  )}
</td>
```

Also update `colSpan={6}` on the "No assets yet" empty-state row to `colSpan={7}` (one more column now).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @vidforge/web typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/api.ts apps/web/components/AssetsBoard.tsx
git commit -m "web: add publish/unpublish toggle to the assets board"
```

---

### Task 2: apps/web — Viewers panel

**Files:**
- Create: `apps/web/components/ViewersPanel.tsx`
- Modify: `apps/web/lib/api.ts`
- Modify: `apps/web/app/org/page.tsx`

**Interfaces:**
- Consumes: `POST /v1/viewers/invite` (`{email}` → 201 `Viewer`), `GET /v1/viewers` (→ `{viewers: Viewer[], pageInfo}`), `POST /v1/viewers/:viewerId/revoke` (→ `{revoked: true}`) — all already shipped by the backend plan.
- Produces: nothing consumed elsewhere in this plan.

Mirrors `apps/web/components/WebhooksPanel.tsx`'s list+create+action pattern exactly (list on mount, inline create form, per-row action button, ADMIN-only gate via a `res.ok` probe rather than trusting client-side role state — same idiom `WebhooksPanel`/`OrgPanel` already use).

- [ ] **Step 1: Add the `Viewer` type**

In `apps/web/lib/api.ts`, append:

```ts
export interface Viewer {
  viewerId: string;
  orgId: string;
  email: string;
  invitedAt: string;
  activatedAt?: string;
  revokedAt?: string;
}
```

- [ ] **Step 2: Create the panel**

Create `apps/web/components/ViewersPanel.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { GATEWAY_URL, authHeaders, type Viewer } from "@/lib/api";

const inputClass =
  "rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none";

function statusOf(v: Viewer): { label: string; className: string } {
  if (v.revokedAt) return { label: "Revoked", className: "text-rose-400" };
  if (v.activatedAt) return { label: "Active", className: "text-emerald-400" };
  return { label: "Invited", className: "text-amber-400" };
}

export function ViewersPanel() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [viewers, setViewers] = useState<Viewer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");

  const refresh = useCallback(async () => {
    const res = await fetch(`${GATEWAY_URL}/v1/viewers`, { headers: authHeaders(), cache: "no-store" });
    setAllowed(res.ok);
    if (res.ok) setViewers((await res.json()).viewers ?? []);
  }, []);

  useEffect(() => void refresh(), [refresh]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/viewers/invite`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : `invite failed: ${res.status}`);
      }
      setEmail("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(viewerId: string) {
    setError(null);
    const res = await fetch(`${GATEWAY_URL}/v1/viewers/${viewerId}/revoke`, {
      method: "POST",
      headers: authHeaders(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(typeof body?.error === "string" ? body.error : `revoke failed: ${res.status}`);
    }
    await refresh();
  }

  if (allowed === null) return null;
  if (!allowed) {
    return <p className="text-sm text-slate-400">Only org admins can manage viewers.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-lg border border-slate-800 p-4">
        <h2 className="mb-3 text-lg font-medium">Invite a viewer</h2>
        <form onSubmit={invite} className="flex flex-wrap items-center gap-2">
          <input
            required
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={`${inputClass} w-64`}
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? "Inviting…" : "Send invite"}
          </button>
        </form>
        {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      </section>

      <section className="overflow-hidden rounded-lg border border-slate-800">
        <h2 className="bg-slate-900 px-4 py-2.5 text-sm font-medium text-slate-300">
          Viewers ({viewers.length})
        </h2>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-800">
            {viewers.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-slate-500">
                  No viewers invited yet.
                </td>
              </tr>
            )}
            {viewers.map((v) => {
              const status = statusOf(v);
              return (
                <tr key={v.viewerId} className="bg-slate-950">
                  <td className="px-4 py-3 text-slate-200">{v.email}</td>
                  <td className={`px-4 py-3 text-xs font-medium ${status.className}`}>{status.label}</td>
                  <td className="px-4 py-3 text-right">
                    {!v.revokedAt && (
                      <button
                        onClick={() => void revoke(v.viewerId)}
                        className="rounded-md border border-rose-800 px-2 py-1 text-xs text-rose-400 hover:bg-rose-950"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Wire into the org page**

In `apps/web/app/org/page.tsx`, add the import:

```ts
import { ViewersPanel } from "@/components/ViewersPanel";
```

Add a new section after the Webhooks section:

```tsx
<section className="flex flex-col gap-3">
  <h2 className="text-xl font-semibold tracking-tight">Viewer portal</h2>
  <ViewersPanel />
</section>
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @vidforge/web typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/api.ts apps/web/components/ViewersPanel.tsx apps/web/app/org/page.tsx
git commit -m "web: add Viewers panel to the org page"
```

---

### Task 3: apps/web — org branding form (+ `GET /v1/org`)

**Files:**
- Modify: `apps/api-gateway/src/routes/org.ts`
- Test: `apps/api-gateway/src/routes/org.test.ts`
- Create: `apps/web/components/OrgBrandingPanel.tsx`
- Modify: `apps/web/lib/api.ts`
- Modify: `apps/web/app/org/page.tsx`

**Interfaces:**
- Consumes: `presign` (existing, from `./playback.js`), `PATCH /v1/org` (existing, unchanged).
- Produces: `GET /v1/org` (ADMIN+) → `{name, slug, displayName, logoUrl}` — consumed only by `OrgBrandingPanel.tsx` below.

`PATCH /v1/org` already exists (backend plan Task 14) but there was never a way to read the *current* branding state, so the form has nothing to populate on load. This task adds the one missing read endpoint the same way the backend plan added `publishedAt` to `GET /v1/assets` for the publish toggle: the smallest read-side addition the already-shipped write-side needs.

- [ ] **Step 1: Write the failing test**

In `apps/api-gateway/src/routes/org.test.ts`, update the `@vidforge/db` mock's `org` stub to add `findUnique` (it currently only has `update`):

```ts
vi.mock("@vidforge/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vidforge/db")>();
  return { ...actual, prisma: { ...actual.prisma, org: { update: vi.fn(), findUnique: vi.fn() } } };
});
```

Add a mock for `./playback.js` (new import this task adds) near the top, after the `@aws-sdk/client-s3` mock:

```ts
vi.mock("./playback.js", () => ({
  presign: vi.fn().mockResolvedValue("https://signed.example/logo.png"),
}));
```

Add the import and a new `describe` block:

```ts
import { presign } from "./playback.js";
```

```ts
describe("GET /v1/org", () => {
  it("returns the org's current identity, presigning the logo if set", async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({
      name: "Acme Inc", slug: "acme-inc", displayName: "Acme Streaming", logoStorageKey: "org-logos/org-1-abc.png",
    } as never);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/org" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: "Acme Inc", slug: "acme-inc", displayName: "Acme Streaming", logoUrl: "https://signed.example/logo.png",
    });
    expect(presign).toHaveBeenCalledWith("org-logos/org-1-abc.png");
  });

  it("returns a null logoUrl when no logo is set", async () => {
    vi.mocked(prisma.org.findUnique).mockResolvedValueOnce({
      name: "Acme Inc", slug: "acme-inc", displayName: null, logoStorageKey: null,
    } as never);
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/org" });
    expect(res.json()).toEqual({ name: "Acme Inc", slug: "acme-inc", displayName: null, logoUrl: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @vidforge/api-gateway test -- org.test.ts`
Expected: FAIL — `GET /v1/org` doesn't exist yet (404).

- [ ] **Step 3: Implement**

In `apps/api-gateway/src/routes/org.ts`, add the import:

```ts
import { presign } from "./playback.js";
```

Add the route as the first route in `registerOrgRoutes` (before `GET /v1/org/members`):

```ts
app.get("/v1/org", { preHandler: requireRole("ADMIN") }, async (req, reply) => {
  const org = await prisma.org.findUnique({
    where: { id: req.authContext!.orgId },
    select: { name: true, slug: true, displayName: true, logoStorageKey: true },
  });
  return reply.send({
    name: org!.name,
    slug: org!.slug,
    displayName: org!.displayName,
    logoUrl: org!.logoStorageKey ? await presign(org!.logoStorageKey) : null,
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @vidforge/api-gateway test -- org.test.ts`
Expected: PASS

- [ ] **Step 5: Add the frontend type and panel**

In `apps/web/lib/api.ts`, append:

```ts
export interface OrgIdentity {
  name: string;
  slug: string;
  displayName: string | null;
  logoUrl: string | null;
}
```

Create `apps/web/components/OrgBrandingPanel.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GATEWAY_URL, authHeaders, type OrgIdentity } from "@/lib/api";

const inputClass =
  "rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none";

function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("failed to read file"));
    reader.readAsDataURL(file);
  });
}

export function OrgBrandingPanel() {
  const [org, setOrg] = useState<OrgIdentity | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`${GATEWAY_URL}/v1/org`, { headers: authHeaders(), cache: "no-store" });
    setAllowed(res.ok);
    if (res.ok) {
      const data = (await res.json()) as OrgIdentity;
      setOrg(data);
      setDisplayName(data.displayName ?? "");
    }
  }, []);

  useEffect(() => void refresh(), [refresh]);

  async function save(patch: { displayName?: string; logoDataUri?: string }) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/org`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : `update failed: ${res.status}`);
      }
      setMessage({ ok: true, text: "Saved." });
      await refresh();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (allowed === null) return null;
  if (!allowed) {
    return <p className="text-sm text-slate-400">Only org admins can edit branding.</p>;
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-slate-800 p-4">
      <div className="flex items-center gap-4">
        {org?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={org.logoUrl} alt="" className="h-12 w-12 rounded object-contain" />
        ) : (
          <div className="h-12 w-12 rounded bg-slate-800" />
        )}
        <div className="flex flex-col gap-1">
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              const logoDataUri = await readFileAsDataUri(file);
              await save({ logoDataUri });
            }}
          />
          <button
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            Upload logo
          </button>
          <p className="text-[11px] text-slate-500">PNG, JPEG or SVG, under 2MB.</p>
        </div>
      </div>

      <label className="flex flex-col gap-1 text-xs text-slate-400">
        Portal display name
        <div className="flex gap-2">
          <input
            placeholder={org?.name ?? ""}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className={`${inputClass} flex-1`}
          />
          <button
            onClick={() => void save({ displayName })}
            disabled={busy}
            className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            Save
          </button>
        </div>
        <span>Shown to viewers in the portal header in place of "{org?.name}".</span>
      </label>

      {org?.slug && <p className="text-xs text-slate-500">Portal slug: <span className="font-mono">{org.slug}</span></p>}
      {message && (
        <p className={`text-xs ${message.ok ? "text-emerald-400" : "text-rose-400"}`}>{message.text}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Wire into the org page**

In `apps/web/app/org/page.tsx`, add the import:

```ts
import { OrgBrandingPanel } from "@/components/OrgBrandingPanel";
```

Add inside the "Viewer portal" section added in Task 2, before `<ViewersPanel />`:

```tsx
<OrgBrandingPanel />
```

- [ ] **Step 7: Typecheck both packages**

Run: `pnpm --filter @vidforge/api-gateway typecheck && pnpm --filter @vidforge/web typecheck`
Expected: PASS

- [ ] **Step 8: Run the gateway test suite**

Run: `pnpm --filter @vidforge/api-gateway test`
Expected: PASS (no regressions)

- [ ] **Step 9: Commit**

```bash
git add apps/api-gateway/src/routes/org.ts apps/api-gateway/src/routes/org.test.ts apps/web/lib/api.ts apps/web/components/OrgBrandingPanel.tsx apps/web/app/org/page.tsx
git commit -m "gateway+web: add GET /v1/org and an org branding form"
```

---

### Task 4: apps/viewer — scaffold the app + core session/api lib

**Files:**
- Create: `apps/viewer/package.json`, `apps/viewer/next.config.ts`, `apps/viewer/tsconfig.json`, `apps/viewer/tailwind.config.ts`, `apps/viewer/postcss.config.mjs`, `apps/viewer/Dockerfile`, `apps/viewer/instrumentation.ts`
- Create: `apps/viewer/app/layout.tsx`, `apps/viewer/app/globals.css`, `apps/viewer/app/page.tsx`
- Create: `apps/viewer/lib/session.ts`
- Test: `apps/viewer/lib/session.test.ts`
- Create: `apps/viewer/lib/api.ts`
- Test: `apps/viewer/lib/api.test.ts`

**Interfaces:**
- Produces: `tokenKey(orgSlug)`, `userKey(orgSlug)` (pure, from `lib/session.ts`), `GATEWAY_URL`, `storeSession(orgSlug, ...)`, `clearSession(orgSlug)`, `getToken(orgSlug)`, `getStoredViewer(orgSlug)`, `portalFetch(orgSlug, path, init?)`, types `ViewerSession`, `LibraryAsset`, `PageInfo`, `ProgressEntry`, `HistoryEntry`, `OrgBranding` (from `lib/api.ts`) — consumed by every later task in this plan. `portalFetch`'s session-revocation handling (plan Review Focus #2) is pinned by `lib/api.test.ts`.

- [ ] **Step 1: Create the package manifest**

Create `apps/viewer/package.json`:

```json
{
  "name": "@vidforge/viewer",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "next dev --port 3001",
    "build": "next build",
    "start": "next start",
    "lint": "next lint || echo ok",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@vercel/otel": "^2.1.3",
    "hls.js": "^1.6.16",
    "next": "^15.1.4",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.5",
    "@types/react": "^19.0.4",
    "@types/react-dom": "^19.0.2",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.17",
    "typescript": "^5.7.2",
    "vitest": "^1.6.1"
  }
}
```

- [ ] **Step 2: Create the remaining scaffold files**

Create `apps/viewer/next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image.
  output: "standalone",
};

export default nextConfig;
```

Create `apps/viewer/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

Create `apps/viewer/tailwind.config.ts`:

```ts
import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
```

Create `apps/viewer/postcss.config.mjs`:

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

Create `apps/viewer/instrumentation.ts` (identical to `apps/web`'s, service name changed):

```ts
// See apps/web/instrumentation.ts for the full rationale — this file's
// register() is Next.js's own OpenTelemetry integration point and runs
// before the server starts handling requests.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerOTel } = await import("@vercel/otel");
  registerOTel({ serviceName: "viewer" });
}
```

Create `apps/viewer/Dockerfile`:

```dockerfile
# Build from the repo root: docker build -f apps/viewer/Dockerfile \
#   --build-arg NEXT_PUBLIC_GATEWAY_URL=https://api.example.com .
FROM node:20-slim AS pruner
RUN npm install -g turbo@2
WORKDIR /repo
COPY . .
RUN turbo prune @vidforge/viewer --docker

FROM node:20-slim AS builder
RUN corepack enable
WORKDIR /app
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .

# Inlined into the client bundle at build time.
ARG NEXT_PUBLIC_GATEWAY_URL=http://localhost:4000
ENV NEXT_PUBLIC_GATEWAY_URL=$NEXT_PUBLIC_GATEWAY_URL
RUN pnpm --filter @vidforge/viewer build

FROM node:20-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/apps/viewer/.next/standalone ./
COPY --from=builder /app/apps/viewer/.next/static ./apps/viewer/.next/static
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
ENV OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
CMD ["node", "apps/viewer/server.js"]
```

Create `apps/viewer/app/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

Create `apps/viewer/app/layout.tsx`:

```tsx
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Video library",
  description: "Watch published videos",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
```

Create `apps/viewer/app/page.tsx` (bare root — the app is only ever reached via `/:orgSlug/...`; this exists so `next build`/`next start` have a valid `/` route):

```tsx
export default function RootPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 text-center">
      <p className="text-sm text-slate-400">
        This is a per-organization video library. Ask your provider for your portal link.
      </p>
    </main>
  );
}
```

- [ ] **Step 3: Write the failing test for session key scoping**

Create `apps/viewer/lib/session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { tokenKey, userKey } from "./session";

describe("session key scoping", () => {
  it("scopes the token key by orgSlug, distinct from apps/web's key", () => {
    expect(tokenKey("acme-inc")).toBe("vidforge.viewer.token.acme-inc");
    expect(tokenKey("other-org")).toBe("vidforge.viewer.token.other-org");
    expect(tokenKey("acme-inc")).not.toBe(tokenKey("other-org"));
  });

  it("scopes the user key by orgSlug the same way", () => {
    expect(userKey("acme-inc")).toBe("vidforge.viewer.user.acme-inc");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd apps/viewer && npx vitest run lib/session.test.ts`
Expected: FAIL — `./session` doesn't exist yet.

- [ ] **Step 5: Implement `lib/session.ts`**

Create `apps/viewer/lib/session.ts`:

```ts
// Every org's portal is served from this one app at a different /:orgSlug
// path, so session state MUST be keyed by orgSlug — a single shared key
// (the way apps/web does it, since apps/web only ever has one org's staff
// logged in per browser profile) would let a session for org A leak into
// org B's portal in the same browser. See the plan's Review Focus #1.
export function tokenKey(orgSlug: string): string {
  return `vidforge.viewer.token.${orgSlug}`;
}

export function userKey(orgSlug: string): string {
  return `vidforge.viewer.user.${orgSlug}`;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/viewer && npx vitest run lib/session.test.ts`
Expected: PASS

- [ ] **Step 7: Implement `lib/api.ts`**

Create `apps/viewer/lib/api.ts`:

```ts
import { tokenKey, userKey } from "./session";

export const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";

export interface ViewerSession {
  viewerId: string;
  orgId: string;
  email: string;
}

export function storeSession(orgSlug: string, token: string, viewer: ViewerSession) {
  localStorage.setItem(tokenKey(orgSlug), token);
  localStorage.setItem(userKey(orgSlug), JSON.stringify(viewer));
}

export function clearSession(orgSlug: string) {
  localStorage.removeItem(tokenKey(orgSlug));
  localStorage.removeItem(userKey(orgSlug));
}

export function getToken(orgSlug: string): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(tokenKey(orgSlug));
}

export function getStoredViewer(orgSlug: string): ViewerSession | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(userKey(orgSlug));
  return raw ? (JSON.parse(raw) as ViewerSession) : null;
}

export function authHeaders(orgSlug: string): Record<string, string> {
  const token = getToken(orgSlug);
  return token ? { authorization: `Bearer ${token}` } : {};
}

// Every protected page's data fetch goes through this, so a revoked or
// expired session is handled in exactly one place: on a 401, clear this
// org's session and send the viewer back to its login page. Without this,
// each page would need to repeat that check itself (see Review Focus #2).
export async function portalFetch(
  orgSlug: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(orgSlug), ...(init.headers ?? {}) },
  });
  if (res.status === 401) {
    clearSession(orgSlug);
    if (typeof window !== "undefined") window.location.href = `/${orgSlug}/login`;
  }
  return res;
}

export interface OrgBranding {
  displayName: string;
  logoUrl: string | null;
}

export interface LibraryAsset {
  assetId: string;
  title: string;
  durationSeconds: number | null;
  latestCompletedJobId: string | null;
}

export interface PageInfo {
  nextPageToken: string;
  totalCount: number;
}

export interface ProgressEntry {
  assetId: string;
  positionSeconds: number;
  updatedAt: string;
}

export interface HistoryEntry {
  assetId: string;
  title: string;
  positionSeconds: number;
  updatedAt: string;
  available: boolean;
  latestCompletedJobId: string | null;
}

export interface ThumbnailsResponse {
  thumbnails: string[];
}
```

- [ ] **Step 8: Add a regression test for `portalFetch`'s session-revocation handling**

This is the plan's Review Focus #2 — a revoked viewer's next API call must clear their session and send them to login. `fetch`, `localStorage`, and `window` are stubbed with `vi.stubGlobal` rather than requiring a jsdom test environment (this package has none, matching `apps/web`'s existing node-only vitest setup).

Create `apps/viewer/lib/api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { portalFetch } from "./api";

function stubBrowserGlobals() {
  const localStorageStub = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
  const windowStub = { location: { href: "" } };
  vi.stubGlobal("localStorage", localStorageStub);
  vi.stubGlobal("window", windowStub);
  return { localStorageStub, windowStub };
}

describe("portalFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears this org's session and redirects to its login page on a 401", async () => {
    const { localStorageStub, windowStub } = stubBrowserGlobals();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    await portalFetch("acme-inc", "/v1/portal/library");

    expect(localStorageStub.removeItem).toHaveBeenCalledWith("vidforge.viewer.token.acme-inc");
    expect(localStorageStub.removeItem).toHaveBeenCalledWith("vidforge.viewer.user.acme-inc");
    expect(windowStub.location.href).toBe("/acme-inc/login");
  });

  it("does not touch the session or redirect on a successful response", async () => {
    const { localStorageStub, windowStub } = stubBrowserGlobals();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })));

    await portalFetch("acme-inc", "/v1/portal/library");

    expect(localStorageStub.removeItem).not.toHaveBeenCalled();
    expect(windowStub.location.href).toBe("");
  });
});
```

Run: `cd apps/viewer && npx vitest run lib/api.test.ts`
Expected: PASS (this pins existing behavior in the file just written above, rather than driving new code — both tests should pass immediately against `portalFetch` as implemented in Step 7).

- [ ] **Step 9: Install dependencies and confirm the package builds**

Run: `pnpm install && pnpm --filter @vidforge/viewer typecheck`
Expected: both succeed. `pnpm install` links the new workspace package (picked up automatically — `pnpm-workspace.yaml`'s `apps/*` glob already covers it, and `turbo.json`'s task definitions apply to every package with a matching script, so no `turbo.json` changes are needed).

- [ ] **Step 10: Run the full test suite for the package**

Run: `pnpm --filter @vidforge/viewer test`
Expected: PASS, 2 files (`session.test.ts`, `api.test.ts`), 4 tests.

- [ ] **Step 11: Commit**

```bash
git add apps/viewer
git commit -m "viewer: scaffold apps/viewer with per-org session storage"
```

---

### Task 5: apps/viewer — org layout, login, and activation

**Files:**
- Create: `apps/viewer/app/[orgSlug]/layout.tsx`
- Create: `apps/viewer/app/[orgSlug]/login/page.tsx`
- Create: `apps/viewer/app/[orgSlug]/activate/[token]/page.tsx`

**Interfaces:**
- Consumes: `GET /v1/portal/org/:orgSlug` (→ `{displayName, logoUrl}`), `POST /v1/portal/auth/login` (→ `ViewerSessionResponse`), `POST /v1/portal/auth/activate` (→ `ViewerSessionResponse`) — all existing. `storeSession`, `GATEWAY_URL`, `OrgBranding` (Task 4).
- Produces: nothing consumed elsewhere in this plan — these are leaf pages.

- [ ] **Step 1: Create the org layout**

Create `apps/viewer/app/[orgSlug]/layout.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { GATEWAY_URL, type OrgBranding } from "@/lib/api";

export default function OrgLayout({ children }: { children: React.ReactNode }) {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [branding, setBranding] = useState<OrgBranding | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`${GATEWAY_URL}/v1/portal/org/${orgSlug}`, { cache: "no-store" });
      if (cancelled) return;
      if (!res.ok) {
        setNotFound(true);
        return;
      }
      setBranding(await res.json());
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug]);

  if (notFound) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 text-center">
        <p className="text-sm text-slate-400">No such video library.</p>
      </main>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-slate-800 px-6 py-4">
        {branding?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={branding.logoUrl} alt="" className="h-8 w-8 rounded object-contain" />
        ) : (
          <div className="h-8 w-8 rounded bg-slate-800" />
        )}
        <h1 className="text-lg font-semibold tracking-tight">{branding?.displayName ?? ""}</h1>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Create the login page**

Create `apps/viewer/app/[orgSlug]/login/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { GATEWAY_URL, storeSession } from "@/lib/api";

const inputClass =
  "rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none disabled:opacity-60";

export default function LoginPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/portal/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "invalid email or password");
      }
      storeSession(orgSlug, data.token, {
        viewerId: data.viewer.viewerId,
        orgId: data.viewer.orgId,
        email: data.viewer.email,
      });
      window.location.href = `/${orgSlug}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 px-6 py-16">
      <h2 className="text-xl font-semibold tracking-tight">Sign in</h2>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          required
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          className={inputClass}
        />
        <input
          required
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          className={inputClass}
        />
        {error && <p className="text-xs text-rose-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 3: Create the activation page**

Create `apps/viewer/app/[orgSlug]/activate/[token]/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { GATEWAY_URL, storeSession } from "@/lib/api";

const inputClass =
  "rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none disabled:opacity-60";

// gRPC ALREADY_EXISTS, mapped to HTTP 409 by /v1/portal/auth/activate —
// this specific case gets a distinct message rather than the raw server
// error, per the plan's Review Focus #3 (re-opening a stale/used link).
const ALREADY_ACTIVATED_STATUS = 409;

export default function ActivatePage() {
  const { orgSlug, token } = useParams<{ orgSlug: string; token: string }>();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyActivated, setAlreadyActivated] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${GATEWAY_URL}/v1/portal/auth/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug, token, password }),
      });
      if (res.status === ALREADY_ACTIVATED_STATUS) {
        setAlreadyActivated(true);
        setBusy(false);
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "this invite link is invalid or expired");
      }
      storeSession(orgSlug, data.token, {
        viewerId: data.viewer.viewerId,
        orgId: data.viewer.orgId,
        email: data.viewer.email,
      });
      window.location.href = `/${orgSlug}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (alreadyActivated) {
    return (
      <main className="mx-auto flex max-w-sm flex-col gap-4 px-6 py-16 text-center">
        <p className="text-sm text-slate-300">
          This account has already been activated.
        </p>
        <a
          href={`/${orgSlug}/login`}
          className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500"
        >
          Sign in instead
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 px-6 py-16">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Set up your account</h2>
        <p className="mt-1 text-sm text-slate-400">Choose a password to finish activating your account.</p>
      </div>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          required
          type="password"
          placeholder="Password (8+ characters)"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          className={inputClass}
        />
        {error && <p className="text-xs text-rose-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? "Activating…" : "Activate account"}
        </button>
      </form>
    </main>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @vidforge/viewer typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/viewer/app/[orgSlug]
git commit -m "viewer: add org branding layout, login, and activation pages"
```

---

### Task 6: apps/viewer — library page (grid, search, continue watching)

**Files:**
- Create: `apps/viewer/lib/library.ts`
- Test: `apps/viewer/lib/library.test.ts`
- Create: `apps/viewer/app/[orgSlug]/page.tsx`

**Interfaces:**
- Consumes: `GET /v1/portal/library` (`?pageSize&pageToken&q` → `{assets, pageInfo}`), `GET /v1/portal/progress` (→ `{progress}`), `GET /v1/portal/jobs/:jobId/thumbnails` (→ `{thumbnails}`) — all existing. `portalFetch`, `getToken`, `LibraryAsset`, `ProgressEntry` (Task 4).
- Produces: `continueWatchingIds(assets, progress, limit): string[]` (from `lib/library.ts`) — used only by this task's page, but kept pure/exported so it's independently testable.

The backend paginates the library (50/page); "Continue watching" is computed only against whichever page is currently loaded — an in-progress asset that hasn't been paged into view yet simply won't appear in that row. Acceptable for v1 (matches the flat-library, no-heavy-personalization scope) and far simpler than a second paginated query cross-referenced against progress server-side.

- [ ] **Step 1: Write the failing test**

Create `apps/viewer/lib/library.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { continueWatchingIds } from "./library";
import type { LibraryAsset, ProgressEntry } from "./api";

const assets: LibraryAsset[] = [
  { assetId: "a1", title: "One", durationSeconds: 100, latestCompletedJobId: "j1" },
  { assetId: "a2", title: "Two", durationSeconds: 100, latestCompletedJobId: "j2" },
  { assetId: "a3", title: "Three", durationSeconds: 100, latestCompletedJobId: "j3" },
];

describe("continueWatchingIds", () => {
  it("returns loaded assets with progress, most recently updated first", () => {
    const progress: ProgressEntry[] = [
      { assetId: "a2", positionSeconds: 10, updatedAt: "2026-01-01T00:00:00.000Z" },
      { assetId: "a1", positionSeconds: 20, updatedAt: "2026-01-02T00:00:00.000Z" },
    ];
    expect(continueWatchingIds(assets, progress, 10)).toEqual(["a1", "a2"]);
  });

  it("ignores progress for assets not in the currently loaded page", () => {
    const progress: ProgressEntry[] = [
      { assetId: "not-loaded", positionSeconds: 5, updatedAt: "2026-01-01T00:00:00.000Z" },
      { assetId: "a3", positionSeconds: 5, updatedAt: "2026-01-01T00:00:00.000Z" },
    ];
    expect(continueWatchingIds(assets, progress, 10)).toEqual(["a3"]);
  });

  it("respects the limit", () => {
    const progress: ProgressEntry[] = [
      { assetId: "a1", positionSeconds: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
      { assetId: "a2", positionSeconds: 1, updatedAt: "2026-01-02T00:00:00.000Z" },
      { assetId: "a3", positionSeconds: 1, updatedAt: "2026-01-03T00:00:00.000Z" },
    ];
    expect(continueWatchingIds(assets, progress, 2)).toEqual(["a3", "a2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/viewer && npx vitest run lib/library.test.ts`
Expected: FAIL — `./library` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/viewer/lib/library.ts`:

```ts
import type { LibraryAsset, ProgressEntry } from "./api";

export function continueWatchingIds(
  assets: LibraryAsset[],
  progress: ProgressEntry[],
  limit: number,
): string[] {
  const loaded = new Set(assets.map((a) => a.assetId));
  return progress
    .filter((p) => loaded.has(p.assetId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map((p) => p.assetId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/viewer && npx vitest run lib/library.test.ts`
Expected: PASS

- [ ] **Step 5: Create the library page**

Create `apps/viewer/app/[orgSlug]/page.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  getToken,
  portalFetch,
  type LibraryAsset,
  type PageInfo,
  type ProgressEntry,
  type ThumbnailsResponse,
} from "@/lib/api";
import { continueWatchingIds } from "@/lib/library";

function Poster({ orgSlug, jobId }: { orgSlug: string; jobId: string | null }) {
  const [poster, setPoster] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    void (async () => {
      const res = await portalFetch(orgSlug, `/v1/portal/jobs/${jobId}/thumbnails`);
      if (!res.ok || cancelled) return;
      const body = (await res.json()) as ThumbnailsResponse;
      if (!cancelled && body.thumbnails?.length) setPoster(body.thumbnails[0]);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug, jobId]);

  if (!poster) {
    return <div className="aspect-video w-full rounded-lg bg-slate-900" />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={poster} alt="" className="aspect-video w-full rounded-lg object-cover" />;
}

function AssetCard({ orgSlug, asset }: { orgSlug: string; asset: LibraryAsset }) {
  return (
    <a
      href={`/${orgSlug}/watch/${asset.assetId}?job=${asset.latestCompletedJobId ?? ""}`}
      className="flex flex-col gap-2"
    >
      <Poster orgSlug={orgSlug} jobId={asset.latestCompletedJobId} />
      <span className="truncate text-sm text-slate-200">{asset.title}</span>
    </a>
  );
}

export default function LibraryPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [pageInfo, setPageInfo] = useState<PageInfo>({ nextPageToken: "", totalCount: 0 });
  const [q, setQ] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);

  const refresh = useCallback(
    async (query: string) => {
      if (!getToken(orgSlug)) {
        window.location.href = `/${orgSlug}/login`;
        return;
      }
      const params = new URLSearchParams({ pageSize: "24", ...(query ? { q: query } : {}) });
      const [libRes, progRes] = await Promise.all([
        portalFetch(orgSlug, `/v1/portal/library?${params}`),
        portalFetch(orgSlug, `/v1/portal/progress`),
      ]);
      if (libRes.ok) {
        const data = await libRes.json();
        setAssets(data.assets ?? []);
        setPageInfo(data.pageInfo ?? { nextPageToken: "", totalCount: 0 });
      }
      if (progRes.ok) {
        setProgress((await progRes.json()).progress ?? []);
      }
    },
    [orgSlug],
  );

  useEffect(() => void refresh(q), [refresh, q]);

  async function loadMore() {
    if (!pageInfo.nextPageToken || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        pageSize: "24",
        pageToken: pageInfo.nextPageToken,
        ...(q ? { q } : {}),
      });
      const res = await portalFetch(orgSlug, `/v1/portal/library?${params}`);
      if (res.ok) {
        const data = await res.json();
        setAssets((prev) => [...prev, ...(data.assets ?? [])]);
        setPageInfo(data.pageInfo ?? { nextPageToken: "", totalCount: 0 });
      }
    } finally {
      setLoadingMore(false);
    }
  }

  const continuing = continueWatchingIds(assets, progress, 8);
  const continuingAssets = continuing
    .map((id) => assets.find((a) => a.assetId === id))
    .filter((a): a is LibraryAsset => !!a);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-8">
      <input
        placeholder="Search titles…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
      />

      {continuingAssets.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Continue watching</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {continuingAssets.map((a) => (
              <AssetCard key={a.assetId} orgSlug={orgSlug} asset={a} />
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">
          Library
          {pageInfo.totalCount > 0 && (
            <span className="ml-2 text-sm font-normal text-slate-500">
              {assets.length} of {pageInfo.totalCount}
            </span>
          )}
        </h2>
        {assets.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing here yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {assets.map((a) => (
              <AssetCard key={a.assetId} orgSlug={orgSlug} asset={a} />
            ))}
          </div>
        )}
        {pageInfo.nextPageToken && (
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="self-center rounded-md border border-slate-700 px-4 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        )}
      </section>
    </main>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @vidforge/viewer typecheck`
Expected: PASS

- [ ] **Step 7: Run the package test suite**

Run: `pnpm --filter @vidforge/viewer test`
Expected: PASS, all tests including the new `library.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add apps/viewer/lib/library.ts apps/viewer/lib/library.test.ts "apps/viewer/app/[orgSlug]/page.tsx"
git commit -m "viewer: add library page with search and continue-watching"
```

---

### Task 7: apps/viewer — Player, watch page, and progress reporting

**Files:**
- Create: `apps/viewer/lib/progress.ts`
- Test: `apps/viewer/lib/progress.test.ts`
- Create: `apps/viewer/components/Player.tsx`
- Create: `apps/viewer/app/[orgSlug]/watch/[assetId]/page.tsx`

**Interfaces:**
- Consumes: `GET /v1/portal/jobs/:jobId/hls/master.m3u8` (raw m3u8), `GET /v1/portal/jobs/:jobId/thumbnails`, `GET /v1/portal/progress`, `PUT /v1/portal/progress/:assetId` — all existing. `getToken`, `portalFetch`, `GATEWAY_URL` (Task 4).
- Produces: `shouldReportProgress(last, next, thresholdSeconds): boolean` (from `lib/progress.ts`) — used only by this task's `Player.tsx`, kept pure/exported for its own test.

The watch page is keyed by `assetId` (per spec: `/:orgSlug/watch/[assetId]`), but playback needs a `jobId` (the portal's hls/thumbnails routes are job-scoped, matching the staff player). Every page that links here (library grid, continue-watching, history) already has `latestCompletedJobId` from its own API response, so the link carries it as a `?job=` query param. A bare/hand-typed `/watch/[assetId]` URL with no `job` param — the only way to reach this page without that context — shows a "no longer available" state instead of guessing: a `latestCompletedJobId` can change over time (re-transcodes), so a stale bookmarked link shouldn't be trusted to resolve to the right job anyway. This satisfies the plan's Review Focus #4.

- [ ] **Step 1: Write the failing test**

Create `apps/viewer/lib/progress.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shouldReportProgress } from "./progress";

describe("shouldReportProgress", () => {
  it("reports on the very first tick (no prior report)", () => {
    expect(shouldReportProgress(null, { atMs: 1_000 }, 10)).toBe(true);
  });

  it("does not report again before the threshold elapses", () => {
    expect(shouldReportProgress({ atMs: 1_000 }, { atMs: 1_000 + 5_000 }, 10)).toBe(false);
  });

  it("reports again once the threshold elapses", () => {
    expect(shouldReportProgress({ atMs: 1_000 }, { atMs: 1_000 + 10_000 }, 10)).toBe(true);
  });

  it("always reports when forced (pause/unload), regardless of elapsed time", () => {
    expect(shouldReportProgress({ atMs: 1_000 }, { atMs: 1_500, forced: true }, 10)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/viewer && npx vitest run lib/progress.test.ts`
Expected: FAIL — `./progress` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/viewer/lib/progress.ts`:

```ts
export interface ProgressTick {
  atMs: number;
  forced?: boolean;
}

// Throttles PUT /v1/portal/progress/:assetId to roughly once per
// thresholdSeconds — the video element's timeupdate event fires ~4x/second,
// far too often to call the API on every tick (plan Global Constraints /
// Review Focus #5). `forced` bypasses the threshold for pause/unload, so a
// short viewing session still gets its final position saved.
export function shouldReportProgress(
  last: { atMs: number } | null,
  next: ProgressTick,
  thresholdSeconds: number,
): boolean {
  if (next.forced) return true;
  if (!last) return true;
  return next.atMs - last.atMs >= thresholdSeconds * 1000;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/viewer && npx vitest run lib/progress.test.ts`
Expected: PASS

- [ ] **Step 5: Create the Player component**

Create `apps/viewer/components/Player.tsx` (adapted from `apps/web/components/Player.tsx`: portal endpoints, per-org token, and progress reporting/resume added):

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { GATEWAY_URL, getToken, portalFetch, type ThumbnailsResponse } from "@/lib/api";
import { shouldReportProgress } from "@/lib/progress";

const PROGRESS_THRESHOLD_SECONDS = 10;

export function Player({
  orgSlug,
  assetId,
  jobId,
  startPositionSeconds,
}: {
  orgSlug: string;
  assetId: string;
  jobId: string;
  startPositionSeconds: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<string[]>([]);
  const [level, setLevel] = useState(-1);
  const hlsRef = useRef<Hls | null>(null);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const lastReportRef = useRef<{ atMs: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await portalFetch(orgSlug, `/v1/portal/jobs/${jobId}/thumbnails`);
      if (!res.ok || cancelled) return;
      const body = (await res.json()) as ThumbnailsResponse;
      if (!cancelled) setThumbnails(body.thumbnails ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug, jobId]);

  useEffect(() => {
    const video = videoRef.current;
    const token = getToken(orgSlug);
    if (!video) return;
    if (!token) {
      setError("Sign in to play this video.");
      return;
    }
    if (!Hls.isSupported()) {
      setError("hls.js is not supported in this browser.");
      return;
    }

    const hls = new Hls({
      xhrSetup: (xhr, url) => {
        if (url.startsWith(GATEWAY_URL)) {
          xhr.setRequestHeader("authorization", `Bearer ${token}`);
        }
      },
    });
    hlsRef.current = hls;
    hls.loadSource(`${GATEWAY_URL}/v1/portal/jobs/${jobId}/hls/master.m3u8`);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
      setLevels(data.levels.map((l) => `${l.height}p`));
      if (startPositionSeconds > 0) video.currentTime = startPositionSeconds;
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) {
        setError(
          data.response?.code === 401 || data.response?.code === 403
            ? "Not authorized to play this video."
            : data.response?.code === 404
              ? "This video is no longer available."
              : `Playback error: ${data.details}`,
        );
        hls.destroy();
      }
    });

    return () => hls.destroy();
  }, [orgSlug, jobId, startPositionSeconds]);

  function reportProgress(positionSeconds: number, forced = false) {
    const now = Date.now();
    if (!shouldReportProgress(lastReportRef.current, { atMs: now, forced }, PROGRESS_THRESHOLD_SECONDS)) return;
    lastReportRef.current = { atMs: now };
    void portalFetch(orgSlug, `/v1/portal/progress/${assetId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionSeconds }),
    });
  }

  function selectLevel(value: number) {
    setLevel(value);
    if (hlsRef.current) hlsRef.current.currentLevel = value;
  }

  function seekToThumbnail(i: number) {
    const video = videoRef.current;
    if (!video || !video.duration || thumbnails.length === 0) return;
    video.currentTime = (i / thumbnails.length) * video.duration;
  }

  if (error) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-slate-800 bg-slate-900">
        <p className="text-sm text-rose-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <video
        ref={videoRef}
        controls
        autoPlay
        playsInline
        onTimeUpdate={(e) => reportProgress(e.currentTarget.currentTime)}
        onPause={(e) => reportProgress(e.currentTarget.currentTime, true)}
        className="aspect-video w-full rounded-lg border border-slate-800 bg-black"
      />
      {levels.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span>Quality:</span>
          <button
            onClick={() => selectLevel(-1)}
            className={`rounded px-2 py-0.5 ${level === -1 ? "bg-sky-600 text-white" : "bg-slate-800 hover:bg-slate-700"}`}
          >
            Auto
          </button>
          {levels.map((label, i) => (
            <button
              key={label}
              onClick={() => selectLevel(i)}
              className={`rounded px-2 py-0.5 ${level === i ? "bg-sky-600 text-white" : "bg-slate-800 hover:bg-slate-700"}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {thumbnails.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {thumbnails.map((src, i) => (
            <button
              key={src}
              onClick={() => seekToThumbnail(i)}
              className="shrink-0 overflow-hidden rounded border border-slate-800 hover:border-sky-500"
              title={`Seek to ${i + 1} of ${thumbnails.length}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt="" className="aspect-video w-24 object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Create the watch page**

Create `apps/viewer/app/[orgSlug]/watch/[assetId]/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Player } from "@/components/Player";
import { getToken, portalFetch, type ProgressEntry } from "@/lib/api";

export default function WatchPage() {
  const { orgSlug, assetId } = useParams<{ orgSlug: string; assetId: string }>();
  const searchParams = useSearchParams();
  const jobId = searchParams.get("job");
  const [startPosition, setStartPosition] = useState<number | null>(null);

  useEffect(() => {
    if (!getToken(orgSlug)) {
      window.location.href = `/${orgSlug}/login`;
      return;
    }
    if (!jobId) return;
    let cancelled = false;
    void (async () => {
      const res = await portalFetch(orgSlug, `/v1/portal/progress`);
      if (!res.ok || cancelled) return;
      const rows = ((await res.json()).progress ?? []) as ProgressEntry[];
      const mine = rows.find((r) => r.assetId === assetId);
      if (!cancelled) setStartPosition(mine?.positionSeconds ?? 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug, assetId, jobId]);

  if (!jobId) {
    return (
      <main className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-12 text-center">
        <p className="text-sm text-slate-400">This video is no longer available.</p>
        <a href={`/${orgSlug}`} className="text-sm text-sky-400 hover:text-sky-300">
          ← Back to library
        </a>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-8">
      <a href={`/${orgSlug}`} className="text-sm text-slate-400 hover:text-slate-200">
        ← Back to library
      </a>
      {startPosition !== null && (
        <Player orgSlug={orgSlug} assetId={assetId} jobId={jobId} startPositionSeconds={startPosition} />
      )}
    </main>
  );
}
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @vidforge/viewer typecheck`
Expected: PASS

- [ ] **Step 8: Run the package test suite**

Run: `pnpm --filter @vidforge/viewer test`
Expected: PASS, all tests including the new `progress.test.ts`.

- [ ] **Step 9: Commit**

```bash
git add apps/viewer/lib/progress.ts apps/viewer/lib/progress.test.ts apps/viewer/components/Player.tsx "apps/viewer/app/[orgSlug]/watch"
git commit -m "viewer: add Player, watch page, and throttled progress reporting"
```

---

### Task 8: apps/viewer — history page

**Files:**
- Create: `apps/viewer/app/[orgSlug]/history/page.tsx`

**Interfaces:**
- Consumes: `GET /v1/portal/history` (→ `{history: HistoryEntry[]}`) — existing. `getToken`, `portalFetch`, `HistoryEntry` (Task 4).
- Produces: nothing consumed elsewhere in this plan.

- [ ] **Step 1: Create the history page**

Create `apps/viewer/app/[orgSlug]/history/page.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getToken, portalFetch, type HistoryEntry } from "@/lib/api";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function HistoryPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!getToken(orgSlug)) {
      window.location.href = `/${orgSlug}/login`;
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await portalFetch(orgSlug, `/v1/portal/history`);
      if (!res.ok || cancelled) return;
      setHistory((await res.json()).history ?? []);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgSlug]);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Watch history</h2>
        <a href={`/${orgSlug}`} className="text-sm text-slate-400 hover:text-slate-200">
          ← Back to library
        </a>
      </div>

      {loaded && history.length === 0 && (
        <p className="text-sm text-slate-500">Nothing watched yet.</p>
      )}

      <div className="flex flex-col divide-y divide-slate-800">
        {history.map((h) => (
          <div key={h.assetId} className="flex items-center justify-between py-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm text-slate-200">{h.title}</span>
              <span className="text-xs text-slate-500">
                Stopped at {formatDuration(h.positionSeconds)} · {new Date(h.updatedAt).toLocaleDateString()}
              </span>
            </div>
            {h.available ? (
              <a
                href={`/${orgSlug}/watch/${h.assetId}?job=${h.latestCompletedJobId ?? ""}`}
                className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
              >
                Resume
              </a>
            ) : (
              <span className="text-xs text-slate-500">No longer available</span>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @vidforge/viewer typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add "apps/viewer/app/[orgSlug]/history"
git commit -m "viewer: add watch history page"
```

---

### Task 9: dev tooling wiring + repo-wide verification

**Files:**
- Modify: `docker-compose.prod.yml`
- Modify: `.claude/skills/run-dev-stack/apps.sh`
- Modify: `.claude/skills/run-dev-stack/SKILL.md`

**Interfaces:** none (wiring + verification only).

- [ ] **Step 1: Add the `viewer` service to `docker-compose.prod.yml`**

In `docker-compose.prod.yml`, add a new service after the `web` service block, mirroring it exactly (port offset +1 from `web`'s 3100, matching the `VIEWER_ORIGIN: http://localhost:3101` value the backend plan already set on `api-gateway`):

```yaml
  viewer:
    build:
      context: .
      dockerfile: apps/viewer/Dockerfile
      args:
        NEXT_PUBLIC_GATEWAY_URL: http://localhost:4100
    init: true
    ports:
      - "3101:3000"
    depends_on:
      api-gateway:
        condition: service_healthy
```

- [ ] **Step 2: Add `apps/viewer` to the dev-stack app-port check**

In `.claude/skills/run-dev-stack/apps.sh`, update the `APP_PORTS` array to include the viewer's dev port:

```bash
APP_PORTS=(3000 3001 4000 50051 50052 50053 50054)
```

Add a verification block after the existing `--- web ---` check, before `--- seeded dev account login ---`:

```bash
echo "--- viewer ---"
code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/)
[[ "$code" == "200" ]] || { echo "viewer root failed: HTTP $code — check /tmp/vidforge-dev.log" >&2; exit 1; }
echo "root: $code"
```

- [ ] **Step 3: Update the skill's description**

In `.claude/skills/run-dev-stack/SKILL.md`, wherever the app list is named (matching the header comment style already in `apps.sh`), add `apps/viewer` to the list of apps this skill brings up (mirroring how `apps.sh`'s own header comment lists the apps it starts).

- [ ] **Step 4: Full repo verification**

Run: `pnpm install && pnpm typecheck`
Expected: PASS across every workspace package, including the new `@vidforge/viewer`.

Run: `pnpm test`
Expected: PASS — every package's suite, including `@vidforge/viewer`'s new `session.test.ts`, `library.test.ts`, `progress.test.ts`.

Run: `pnpm --filter @vidforge/viewer build`
Expected: PASS — confirms the new app actually builds standalone, not just typechecks.

- [ ] **Step 5: Bring up the dev stack and verify end to end**

If you have Docker available, run the `run-dev-stack` skill (or `.claude/skills/run-dev-stack/apps.sh` directly) and confirm the new `--- viewer ---` check passes alongside the existing ones. This is the first point in either plan where `apps/viewer` is actually exercised against a live gateway — worth doing manually (open `http://localhost:3001/dev-org` in a browser, using the seeded `dev-org` from `packages/db/prisma/seed.ts`) if you want to see the library render, even though seeded assets aren't published by default (toggle one via `apps/web`'s new publish button first, or seed data directly, to see the library populated).

- [ ] **Step 6: Commit**

```bash
git add docker-compose.prod.yml .claude/skills/run-dev-stack/apps.sh .claude/skills/run-dev-stack/SKILL.md
git commit -m "chore: wire apps/viewer into dev-stack tooling and prod compose"
```
