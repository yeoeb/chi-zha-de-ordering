# Main development and release policy

`main` is the sole stable source baseline for this repository. Start new work from
the latest GitHub `main`, using `feature/*` for features and `fix/*` for bug fixes.
Retain the repository's existing commit history and engineering documents.

Complete tests and review a pull request before merging back to `main`. The local
gate is two runs of `npm run test`, followed by `npm run check`, `npm run build`,
`npm run verify`, and `git diff --check`. `npm run verify` checks PWA assets and
isolated local D1 fresh/upgrade/menu/scheduler behavior; it does not deploy or
operate on Production D1.

A GitHub main update does not publish Cloudflare Production. Deployment remains
subject to an independent, explicitly authorized Release Gate. Production D1
migrations/data patches and Scheduler activation each retain their documented
authorization boundaries in `SCHEDULER_ACTIVATION_RELEASE.md` and
`DEPLOYMENT_RUNBOOK.md`.

Before any push or merge, check both refs for deployment workflows and inspect
external Git integrations/webhooks. Stop if the operation would automatically
deploy Production. Keep live credentials, Access JWTs/cookies, VAPID private keys,
database exports, logs, dependency directories and temporary build/test artifacts
out of the public repository. Example configuration values are allowed.
