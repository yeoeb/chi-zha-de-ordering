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
- For LINE-enabled releases, both `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_MERCHANT_RECIPIENT_ID` are sensitive operational secrets. Keep them out of source, Wrangler vars, logs, URLs, API responses, screenshots, documentation values, shell history, and chat.
- Exact `MERCHANT_HOSTNAME` for the Access-protected hostname.
- Exact `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` for the Merchant Access application.

The first staging release uses `workers_dev=true`, `preview_urls=false`, `MERCHANT_HOSTNAME=chi-zha-de-ordering.yeoeb55688.workers.dev`, and `NOTIFICATION_PROVIDER=disabled`.

`MERCHANT_DEV_BYPASS` and `PUBLIC_WRITE_RATE_LIMIT_DEV_BYPASS` must be absent. Review the generated Worker bundle/config before release.

## Notification release modes and secrets

Mode A (recommended first deployment) sets `NOTIFICATION_PROVIDER=disabled`. The Worker starts normally, Orders remain durable, Merchant polling remains authoritative, and each new Order's notification intent records a sanitized `NOTIFICATION_DISABLED` failure. Fake delivery is accepted only alongside the explicit development bypass; do not configure `fake` or either development bypass in production.

Mode B sets `NOTIFICATION_PROVIDER=line` and supplies both `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_MERCHANT_RECIPIENT_ID` as version-managed Cloudflare secrets. Missing or invalid LINE configuration selects the disabled provider; it does not fail Worker startup or Order creation.

Do not commit either value, put either value on a command line, or expose them in logs or responses. `wrangler secret put` creates a new Worker version and deploys it immediately, so it is prohibited for the staged version workflow. After explicit approval, create an access-restricted temporary JSON or `.dev.vars` file outside the repository containing both values, then create one non-deployed Worker version using:

```powershell
npm.cmd exec wrangler -- versions secret bulk <temporary-secret-file> --name chi-zha-de-ordering
```

The temporary file must never be committed and must be removed after its contents are confirmed in the created version metadata without reading values back. This command creates a version containing the secrets but does not shift traffic. Capture its version ID and stop before the separately approved `npm.cmd exec wrangler -- versions deploy <VERSION_ID>@100%`. Confirm both values are absent from logs, API responses, notification errors, source, `.env`, build output, documentation, shell history, and chat.

The current repository has no LINE webhook, webhook signature validation, or automatic Merchant recipient-ID capture. Obtain the recipient ID from an actual, signature-validated LINE webhook event after the Merchant interacts with the Official Account, or from another verified LINE Official Account administrative source. Do not invent, derive, or request the value in chat. Adding a webhook capture flow requires a separate scoped change and security review.

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

The first workers.dev staging deployment was explicitly approved and completed from Git SHA `20bc8f2d21f0fb2c9956571da5e1e3a7fcd54919`:

- Worker version: `89762920-85ab-42f4-8ef9-e693a1d80180`
- Deployment: `4e04d117-0ef0-4c8d-901a-467eddb4779f`
- URL: `https://chi-zha-de-ordering.yeoeb55688.workers.dev`
- Store state at and after verification: paused (`is_accepting_orders = 0`)

Future deployments still require a clean reviewed checkpoint and explicit approval:

```powershell
npm.cmd exec wrangler -- deploy
npm.cmd exec wrangler -- deployments list
```

Capture the new version/deployment ID and do not open Customer traffic until smoke verification passes.

## Post-deploy smoke

Gate 12F completed the public read-only Customer/PWA smoke and confirmed unauthenticated Merchant paths are intercepted by Access. Gate 13 completed an Access-authenticated read-only Merchant smoke: the Merchant UI loaded and the Merchant Orders API returned `200`. No Merchant mutation, Order creation, LINE action, D1 mutation, Access change, or opening of ordering occurred. The post-smoke D1 check showed zero Orders, zero notification deliveries, and the store still paused.

The remaining controlled mutation smoke requires separate explicit approval:

- Public: health, Store, Menu, Quote, one controlled Order, idempotent retry, token-based Customer status, and unknown API 404.
- Merchant through Access: queue read, notification read, accept/complete, sold-out/restore, pause/resume, and retry action.
- Security: public Merchant request denied, opaque lookup only, Rate Limiting binding active, no caching on Order/Merchant responses, and no development bypass.
- Data: authoritative prices, snapshots, persisted ETA, one Order, and one notification intent.

## LINE verification

Requires separate explicit authorization:

1. Confirm the Official Account/channel and acquire the Merchant recipient through a legitimate verified source.
2. Configure both secrets through the approved version-only bulk flow without exposing their values; do not deploy that version yet.
3. Prefer a controlled, non-public provider-level diagnostic using the actual LINE transport. Do not create a fake Order, resume the store, or add a temporary public endpoint.
4. Send exactly one harmless text message after a separate explicit external-send approval: `吃炸的系統測試通知`, `店家通知功能連線成功。`, `此訊息為上線前測試，無須處理。`
5. Confirm no full phone, public token, internal ID, recipient ID, or credential appears in output or logs.
6. Confirm the Merchant receives exactly one message and no duplicate send occurs.
7. Treat a timeout/network failure as delivery-ambiguous: D1 guards one logical intent and concurrent claims, but the current LINE request has no provider retry key and cannot guarantee external exactly-once delivery if LINE accepted the request before the response was lost.
8. Keep the Order-coupled delivery/retry scenario for a later separately approved controlled Order test; provider failure must never change Order durability.

## PWA verification

Over HTTPS on the intended Merchant hostname, verify manifest, 192/512 icons, Service Worker registration, standalone installation, Merchant startup at `/merchant`, live five-second refresh, and controls. Verify the Customer app works normally. Inspect network/cache behavior to prove `/api/*` is never served by the Service Worker and offline Order submission fails visibly rather than being queued.

## Rollback

### Application rollback

The current first deployment has no earlier Worker version to roll back to. If it is unhealthy, keep the store paused, disable/remove Worker exposure if necessary, fix forward, and deploy a corrected version. Once a known-good earlier version exists and is compatible with the current D1 schema:

```powershell
npm.cmd exec wrangler -- deployments list
npm.cmd exec wrangler -- rollback <previous-version-id>
```

Re-run health, Customer read, and Access-authenticated Merchant smoke checks. Worker rollback does not revert D1, bindings, secrets, Access, routes, or data.

### Database recovery

Prefer a reviewed forward corrective migration. Before any risky migration, record the D1 Time Travel bookmark. If data/schema restoration is necessary, stop writes, identify the precise pre-change bookmark, obtain separate destructive-operation approval, and use D1 Time Travel according to Cloudflare's current procedure. Restoring D1 overwrites database state and is independent of Worker rollback; never automate it as part of application rollback.
