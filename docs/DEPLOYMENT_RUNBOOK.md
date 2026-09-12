# Deployment runbook

Every remote mutation is separately gated. Never infer deployment, D1, secret, Access, LINE-cleanup, or store-resume authorization from this document.

## Prerequisites

- Clean reviewed Git commit and recorded candidate SHA.
- `npm test`, `npm run check`, `npm run build`, fresh-D1 verification, and Wrangler dry-run pass.
- Correct Cloudflare account and Worker `chi-zha-de-ordering` confirmed.
- Production D1 remains healthy and the store remains paused.
- Cloudflare Access still protects `/merchant*` and `/api/merchant/*` while Customer routes remain public.
- VAPID material is created outside Git/chat only when separately authorized.

## Pre-deploy verification

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run build
npm.cmd run verify:fresh-d1
npm.cmd run verify:deploy-dry-run
git status --short --branch
git rev-parse HEAD
```

Read-only remote checks must confirm pending migrations, `PRAGMA quick_check`, store pause, Menu counts, Orders, and current deployments/versions.

## Production D1 migration

The Web-only candidate requires additive/forward migration `0009_create_merchant_push_subscriptions.sql`. Because it has not been applied remotely, it was redesigned before rollout to leave the historical LINE-era `notification_deliveries` table untouched and create separate `web_push_notification_deliveries` and `merchant_push_subscriptions` tables. Migrations `0001` through `0008` remain unchanged.

Future gated sequence:

```powershell
npm.cmd exec wrangler -- d1 migrations list DB --remote
npm.cmd exec wrangler -- d1 time-travel info DB
npm.cmd exec wrangler -- d1 migrations apply DB --remote
npm.cmd exec wrangler -- d1 migrations list DB --remote
```

After apply, use read-only queries to verify migration 0009, the untouched historical delivery table, Web Push intent/subscription uniqueness and indexes, empty initial Web Push tables, store pause, Menu counts, Orders, and `PRAGMA quick_check = ok`. Never apply a migration when an unexpected file appears in the pending list.

## Configuration and secrets

Non-secret Worker variables required to enable Web Push:

- `VAPID_PUBLIC_KEY`
- `VAPID_SUBJECT` (`mailto:` or HTTPS URL)

Secret:

- `VAPID_PRIVATE_KEY`

Generate the key pair outside the repository. Never print or commit the private key. Prefer uploading code and the private Secret into the same non-active Worker version using a restricted temporary file and the current Wrangler `versions upload --secrets-file` workflow. Delete the explicit temporary file after successful version capture. Do not use a secret command that immediately shifts traffic.

Missing VAPID configuration leaves Orders and Merchant polling operational; it only makes Push deliveries fail observably as unconfigured.

Obsolete remote LINE secrets must not be deleted until the Web-only Worker version is deployed and verified, and deletion must have a separate authorization.

## Cloudflare Access

- Public: Customer SPA and Customer APIs.
- Private: `/merchant*` and `/api/merchant/*`.
- The Worker guard must validate the expected hostname, Access issuer, audience, and signed `Cf-Access-Jwt-Assertion`.
- No Production development bypass.
- Do not protect the whole Worker and block Customer traffic.
- Review workers.dev, preview, alternate routes, and eventual Custom Domains for bypass paths.

## Candidate upload and deployment

1. Upload exactly one non-active version with reviewed source/config and VAPID Secret.
2. Record candidate version ID and confirm current active traffic is unchanged.
3. Use version overrides for read-only smoke while the store remains paused.
4. Promote only the exact verified version through a separate approval:

```powershell
npm.cmd exec wrangler -- versions deploy <VERSION_ID>@100% -y
```

Never repeat an ambiguous upload or deploy automatically.

## Post-deploy smoke

While paused:

- Public `GET /`, `/api/health`, `/api/store`, `/api/menu`.
- Manifest, icons, and Service Worker over HTTPS.
- Unauthenticated Merchant surface is intercepted by Access.
- Authenticated Merchant Orders and availability reads succeed through the Worker guard.
- LINE webhook/pairing routes return Worker 404.
- Push public-key and subscription routes require Merchant authorization.
- No Order is created during read-only smoke.

Then, under a separate controlled authorization:

1. Merchant taps **Enable notifications** in the protected PWA.
2. Browser permission prompt is accepted.
3. Verify one idempotent D1 subscription row without selecting or logging credentials.
4. Create one clearly identified test Order only if authorized.
5. Verify one minimal Push, the Merchant opens `/merchant`, and authoritative data comes from the API.
6. Verify polling remains available if Push is denied or fails.

## PWA verification

- Manifest, 192/512 icons, and Service Worker load over HTTPS.
- Installed Merchant PWA opens behind Access.
- Push permission is never requested on page load.
- Notification click focuses or opens `/merchant`.
- `/api/*` is never served from Service Worker cache.
- Offline Order submission remains impossible.

## Rollback and recovery

Application rollback and D1 recovery are independent.

Application rollback:

- Keep the store paused.
- Inspect deployments and versions.
- Deploy the last known-good Worker version only with explicit approval.
- Verify bindings and routes afterward.

D1 recovery:

- Worker rollback does not undo migration 0009 or subscription rows.
- Prefer a reviewed forward migration.
- D1 Time Travel restore changes remote data and needs a separate destructive-recovery gate.
- Never run a remote reset, wipe, blind rollback, or unreviewed DELETE.

Push cleanup:

- Invalid endpoints are removed automatically only after push services return 404/410.
- A Merchant can idempotently unsubscribe its own current browser endpoint.
- Do not expose or manually copy stored subscription credentials.

Store resume is always a separate final mutation after smoke verification; rollback never implies automatic resume.
