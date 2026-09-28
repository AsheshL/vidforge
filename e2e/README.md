# End-to-end tests

Playwright suite that exercises VidForge the way users and integrators do,
against a real running stack: gateway, services, worker, Postgres, Redis,
MinIO and Mailpit. Two projects:

- **`api`**: the HTTP API directly (`tests/api/`), including tus uploads,
  real transcodes, HLS playback, emails and webhook deliveries.
- **`ui`**: the web app in Chromium (`tests/ui/`), signed in per role.

## Running

```bash
.claude/skills/run-dev-stack/apps.sh   # from the repo root: stack up, migrated, seeded
docker compose up -d mailpit           # invite emails land here
pnpm e2e                               # everything (~2 min)

pnpm --filter @vidforge/e2e e2e:api    # one project
pnpm --filter @vidforge/e2e e2e -g webhooks
pnpm --filter @vidforge/e2e e2e:report # HTML report of the last run
```

Requirements on the machine running the tests: `ffmpeg`/`ffprobe` (test
media and codec checks) and Playwright's Chromium.

| Variable | Default | Purpose |
|---|---|---|
| `E2E_WEB_URL` | `http://localhost:3000` | web app |
| `E2E_GATEWAY_URL` | `http://127.0.0.1:4000` | api-gateway |
| `E2E_MAILPIT_URL` | `http://127.0.0.1:8025` | Mailpit API |
| `REDIS_URL` | `redis://localhost:6379` | where setup clears rate-limit counters |
| `E2E_RESET_RATE_LIMITS` | on | `0` keeps the auth rate-limit counters |
| `E2E_BROWSER_CHANNEL` | bundled Chromium | `chrome` runs the UI project in Google Chrome |

Notes:

- **Webhook delivery** tests post to a localhost receiver. jobs-svc refuses
  private targets unless `.env` has `WEBHOOK_ALLOW_PRIVATE_TARGETS="true"`;
  without it they skip. With it, the SSRF-guard test skips instead, because
  the guard is off by design in that mode.
- **Video playback**: Playwright's bundled Chromium has no H.264/AAC
  decoders. In it, the player test checks everything up to decoding (page,
  playlists, segments). Actual playback, quality switching and thumbnail
  seeking are asserted when the browser supports H.264, e.g. with
  `E2E_BROWSER_CHANNEL=chrome`. Codec correctness itself is verified with
  ffprobe in `tests/api/transcode-playback.spec.ts`.
- **Rate limits**: signup and invites are rate-limited with counters in
  Redis that outlive restarts. Global setup clears the `vidforge:rl:*` keys
  so repeated runs don't hit 429s. Local stacks only.
- Tests share the seeded database and run serially (`workers: 1`). They
  create uniquely named data and restore anything they change (roles,
  webhooks).

## What's covered

| Area | API (`tests/api/`) | UI (`tests/ui/`) |
|---|---|---|
| Auth | dev login per role; bad tokens; signup → login → change password; validation (`auth`) | signed-out view; signup into a fresh org, sign out, wrong password, sign in (`auth`) |
| Uploads | tus upload + register; duplicate/unknown keys; viewer denied (`uploads`) | upload through the page's tus client (`dashboard`) |
| Transcoding | two-rendition job, live SSE progress, asset READY + duration; validation; viewer denied (`transcode-playback`) | transcode with a chosen preset, live progress to Completed; seed test video (`dashboard`) |
| Output quality | every rendition is browser-playable H.264 High / yuv420p + AAC at the requested size, from a 4:4:4 source, and decodes cleanly (`transcode-playback`) | — |
| Playback | master/variant playlists, presigned segments, path-traversal and non-playlist rejection (`transcode-playback`) | watch page, HLS fetches; playback, quality levels and thumbnail seek where H.264 is available; unknown job (`player`) |
| Thumbnails | presigned JPEGs (`transcode-playback`) | asset poster (`dashboard`) |
| Job lifecycle | re-run with another profile; idempotency key; cancel → delete; unreadable source retries then FAILED; viewer can't cancel/delete (`jobs`) | re-run, delete (`dashboard`) |
| Listing | cursor pagination for assets and jobs; page-size default and clamping (`jobs`) | — |
| Roles | viewer/editor/admin limits across every area | viewer sees no editing or admin controls (`dashboard`, `org`) |
| Org isolation | another org can't list, read, play, cancel, delete, or transcode dev-org's assets, or borrow their source (`org-isolation`) | — |
| Org admin | members/audit admin-only; role change audited, OWNER not grantable; invite → email → temp password → forced change; re-invite rotates the temp password; bulk invite partial results (`org-admin`) | role change + audit row; invite + bulk invite; invitee's first sign-in, forced password change, settings password change, sign back in (`org`, `onboarding`) |
| API keys | create → authenticate within role → list without secret → revoke; expired keys; can't outrank creator (`api-keys`) | create, one-time secret, revoke (`org`) |
| Webhooks | admin-only, org-scoped, one-time secret; validation; SSRF guard; signed deliveries per subscription; 5xx retried, 410 not; failing job → retrying ×2 → failed (`webhooks`) | add with chosen events, one-time secret, delete (`org`) |
