# Viewer portal diagrams

Interactive, self-contained HTML diagrams for the viewer portal feature (see
`docs/superpowers/specs/2026-09-28-viewer-portal-design.md` and the backend/frontend
plans in `docs/superpowers/plans/`). Open any `.html` file directly in a browser —
each supports pan/zoom, guided views, dark/light themes, and search.

- `architecture.html` — system architecture: staff (`apps/web`) and customer
  (`apps/viewer`) paths through `api-gateway`, the structural identity boundary
  between staff and viewer identity, and the video-svc/S3 playback path.
- `onboarding-sequence.html` — invite → email → activate → session.
- `playback-sequence.html` — browse → publish-gate check → stream.

The matching `.json` files are the [Archify](https://github.com/tt-a1i/archify)
source specs used to generate the HTML. To regenerate after a source change:

```bash
node <path-to-archify-skill>/bin/archify.mjs deliver architecture architecture.json architecture.html --quality showcase --repo-root <repo-root>
node <path-to-archify-skill>/bin/archify.mjs deliver sequence onboarding-sequence.json onboarding-sequence.html --quality showcase
node <path-to-archify-skill>/bin/archify.mjs deliver sequence playback-sequence.json playback-sequence.html --quality showcase
```
