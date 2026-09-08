# Deployment runbook

Production deployment is not approved by this document. Run remote or mutating commands only during an explicitly authorized release task.

## Prerequisites

- Clean, reviewed Git checkpoint and an explicit release approval.
- Cloudflare account/zone access, Zero Trust enabled, and permission to manage Workers, D1, Rate Limiting, domains, and Access.
- For the first staging release, the registered workers.dev hostname with path-scoped Merchant Access already configured. Separate Customer/Merchant Custom Domains remain a later production gate.
- For a LINE-enabled release: LINE Official Account, Messaging API channel, Merchant recipient ID, and reviewed quota/pricing. These are not prerequisites for an explicitly disabled initial release.
- No `.dev.vars`, development bypass, credential, or secret value in Git or the build artifact. Reviewed non-secret resource identifiers belong in deployment configuration.

## Pre-deploy verification

```powershell
npm ci
npm test
npm run check
npm run build
npm run verify:fresh-d1
npm run verify:deploy-dry-run
git status --short
git rev-parse HEAD
```

Record the release commit, current Worker deployment/version, current D1 Time Travel bookmark, configuration review, and smoke-test owner.

## Production D1

The approved remote database already exists:

- Binding: `DB`
- Name: `chi-zha-de-db`
- ID: `d104f4b2-1be3-4d4b-b781-008807206dd3`
- Location: APAC

Do not create a second database. Before deployment, verify the binding and query the paused Store/Menu state read-only.

## Migration procedure

Migrations are sequential and forward-applied. Migration `0001` creates the required single-store `吃炸的` settings row. `seeds/development.sql` is disposable local Menu fixture data and must never run against production.

```powershell
npm.cmd exec wrangler -- d1 migrations list DB --remote
npm.cmd exec wrangler -- d1 time-travel info DB
```

All seven migrations and the reviewed `production-data/initial-store-menu.sql` data write have already been applied. Never rerun that file against the populated database. Verify tables, indexes, constraints, `PRAGMA quick_check`, Store/Menu counts, and `is_accepting_orders = 0` read-only before deployment.

## Configuration

Production non-secret configuration must include:

- Real production D1 ID bound as `DB`.
- Production Rate Limiting namespace bound as `ORDER_RATE_LIMITER`.
- `NOTIFICATION_PROVIDER=disabled` for the recommended initial release, or `NOTIFICATION_PROVIDER=line` only when both LINE values are configured and a real smoke is authorized.
- `LINE_MERCHANT_RECIPIENT_ID` for LINE-enabled releases. This is a non-secret operational identifier, but keep it out of public source, logs, URLs, and API responses as confidential deployment configuration.
- Exact `MERCHANT_HOSTNAME` for the Access-protected hostname.
- Exact `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` for the Merchant Access application.

The first staging release uses `workers_dev=true`, `preview_urls=false`, `MERCHANT_HOSTNAME=chi-zha-de-ordering.yeoeb55688.workers.dev`, and `NOTIFICATION_PROVIDER=disabled`.

`MERCHANT_DEV_BYPASS` and `PUBLIC_WRITE_RATE_LIMIT_DEV_BYPASS` must be absent. Review the generated Worker bundle/config before release.

## Notification release modes and secrets

Mode A (recommended first deployment) sets `NOTIFICATION_PROVIDER=disabled`. The Worker starts normally, Orders remain durable, Merchant polling remains authoritative, and each new Order's notification intent records a sanitized `NOTIFICATION_DISABLED` failure. Fake delivery is accepted only alongside the explicit development bypass; do not configure `fake` or either development bypass in production.

Mode B sets `NOTIFICATION_PROVIDER=line`, supplies the non-secret confidential `LINE_MERCHANT_RECIPIENT_ID`, and stores `LINE_CHANNEL_ACCESS_TOKEN` as a Cloudflare Secret. Missing or invalid LINE configuration selects the disabled provider; it does not fail Worker startup or Order creation.

Do not commit the token, put it on a command line, or expose either LINE value in logs or responses. `wrangler secret put` creates a new Worker version and deploys it immediately, so it is prohibited during pre-deployment preparation. After the Worker resource/version boundary exists and only during an authorized version-based release, prepare the token interactively without deploying it using:

```powershell
npm.cmd exec wrangler -- versions secret put LINE_CHANNEL_ACCESS_TOKEN --name chi-zha-de-ordering
```

This command creates a version containing the secret but does not deploy that version. Confirm the exact version identifier before any later deployment. Configure the recipient through the reviewed deployment configuration/dashboard boundary without printing it in the transcript. Confirm the token is absent from logs, API responses, notification errors, source, `.env`, build output, and documentation.

## Cloudflare Access

- Staging Customer routes remain public on `chi-zha-de-ordering.yeoeb55688.workers.dev`.
- The self-hosted Access application protects only `/merchant*` and `/api/merchant/*` on that host.
- The Worker guard is configured with that exact hostname, `https://yeoeb.cloudflareaccess.com`, and the manually verified application audience.
- The guard accepts an Access assertion only after exact-hostname matching and cryptographic JWT signature/issuer/audience validation. An Access-looking header on another hostname is untrusted.
- For the current shared workers.dev host, confirm only the two Merchant path patterns trigger Access and Customer paths remain public. On future separate Custom Domains, block or redirect `/merchant` on the Customer hostname as defense in depth.
- Keep workers.dev enabled only for this staging phase and preview URLs disabled. After verified Custom Domains exist, disable workers.dev and keep previews disabled.
- Test unauthenticated, authenticated, expired-token, forged-header, wrong-audience, Customer-host, `workers.dev`, and preview access before launch.

Do not protect the entire shared Worker with a Worker-level Access policy because that would also require Customer authentication.

## Custom domain and alternate exposure

Attach the same reviewed Worker release to the public Customer and Access-protected Merchant hostnames only. Inventory Domains & Routes after deployment. Confirm no old route, alternate Custom Domain, `workers.dev` URL, or preview deployment can bypass the Merchant hostname/Access boundary.

## Deployment

Only after the final pre-deploy gate passes and explicit Gate 12 approval is given:

```powershell
npm.cmd exec wrangler -- deploy
npm.cmd exec wrangler -- deployments list
```

Capture the new version/deployment ID and do not open Customer traffic until smoke verification passes.

## Post-deploy smoke

- Public: health, Store, Menu, Quote, one controlled Order, idempotent retry, token-based Customer status, and unknown API 404.
- Merchant through Access: queue read, notification read, accept/complete, sold-out/restore, pause/resume, and retry action.
- Security: public Merchant request denied, opaque lookup only, Rate Limiting binding active, no caching on Order/Merchant responses, and no development bypass.
- Data: authoritative prices, snapshots, persisted ETA, one Order, and one notification intent.

## LINE verification

Requires separate explicit authorization:

1. Confirm the Official Account/channel and Merchant recipient.
2. Configure secrets without exposing their values.
3. Submit one controlled Order and receive exactly one short notification.
4. Confirm no full phone, public token, internal ID, or credential appears.
5. Simulate provider failure and confirm the Order remains successful/pending.
6. Use Merchant retry once, confirm `attempt_count` increments and delivery becomes `sent`.
7. Confirm Order/idempotent retries do not duplicate notification intents or sends.

## PWA verification

Over HTTPS on the intended Merchant hostname, verify manifest, 192/512 icons, Service Worker registration, standalone installation, Merchant startup at `/merchant`, live five-second refresh, and controls. Verify the Customer app works normally. Inspect network/cache behavior to prove `/api/*` is never served by the Service Worker and offline Order submission fails visibly rather than being queued.

## Rollback

### Application rollback

The first deployment has no prior Worker version. If it is unhealthy, keep the store paused, disable/remove Worker exposure if necessary, fix forward, and deploy a corrected version. Once a known-good earlier version exists and is compatible with the current D1 schema:

```powershell
npm.cmd exec wrangler -- deployments list
npm.cmd exec wrangler -- rollback <previous-version-id>
```

Re-run health, Customer read, and Access-authenticated Merchant smoke checks. Worker rollback does not revert D1, bindings, secrets, Access, routes, or data.

### Database recovery

Prefer a reviewed forward corrective migration. Before any risky migration, record the D1 Time Travel bookmark. If data/schema restoration is necessary, stop writes, identify the precise pre-change bookmark, obtain separate destructive-operation approval, and use D1 Time Travel according to Cloudflare's current procedure. Restoring D1 overwrites database state and is independent of Worker rollback; never automate it as part of application rollback.
