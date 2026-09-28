# Viewer portal diagrams

Interactive, self-contained HTML diagrams for the viewer portal feature (see
`docs/superpowers/specs/2026-09-28-viewer-portal-design.md` and the backend/frontend
plans in `docs/superpowers/plans/`). Each supports pan/zoom, guided views,
dark/light themes, and search.

Live, rendered versions (via GitHub Pages, served from the `gh-pages` branch):

- [architecture.html](https://asheshl.github.io/vidforge/viewer-portal/architecture.html) —
  system architecture: staff (`apps/web`) and customer (`apps/viewer`) paths through
  `api-gateway`, the structural identity boundary between staff and viewer identity,
  and the video-svc/S3 playback path.
- [onboarding-sequence.html](https://asheshl.github.io/vidforge/viewer-portal/onboarding-sequence.html) —
  invite → email → activate → session.
- [playback-sequence.html](https://asheshl.github.io/vidforge/viewer-portal/playback-sequence.html) —
  browse → publish-gate check → stream.

The `.html` files here (and their matching `.json` source specs, for the
[Archify](https://github.com/tt-a1i/archify) tool that generated them) are the
source of truth on `main`; the `gh-pages` branch is a manually-pushed copy of
the rendered HTML for live hosting. To regenerate after a source change:

```bash
node <path-to-archify-skill>/bin/archify.mjs deliver architecture architecture.json architecture.html --quality showcase --repo-root <repo-root>
node <path-to-archify-skill>/bin/archify.mjs deliver sequence onboarding-sequence.json onboarding-sequence.html --quality showcase
node <path-to-archify-skill>/bin/archify.mjs deliver sequence playback-sequence.json playback-sequence.html --quality showcase
```

Then copy the updated `.html` files to a checkout of the `gh-pages` branch (under
`viewer-portal/`) and push, to update the live pages.
