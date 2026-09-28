# AWS architecture diagram

Interactive, self-contained HTML diagram of VidForge's high-level AWS
architecture — grounded in `infra/terraform/` and `docs/aws-deployment.md`.
Open `architecture.html` directly in a browser, or view it live (see the
repo README).

**This reflects the Terraform-defined target architecture, not necessarily
what's currently live.** The AWS footprint was torn down 2026-09-25 after
the feature freeze — verify live resources (`aws ecs list-clusters`, etc.)
before assuming anything in this diagram is actually running. See
`docs/aws-deployment.md` and the `vidforge-deployment-phase` project memory
for the full context.

`architecture.json` is the [Archify](https://github.com/tt-a1i/archify)
source spec. To regenerate after a Terraform/source change:

```bash
node <path-to-archify-skill>/bin/archify.mjs deliver architecture architecture.json architecture.html --quality showcase --repo-root <repo-root>
```

Then copy the updated `architecture.html` to a checkout of the `gh-pages`
branch (under `aws/`) and push, to update the live page.
