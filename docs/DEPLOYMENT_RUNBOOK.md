# Deployment runbook

Production deployment is not approved by this document. Run remote or mutating commands only during an explicitly authorized release task.

## Prerequisites

- Clean, reviewed Git checkpoint and an explicit release approval.
- Cloudflare account/zone access, Zero Trust enabled, and permission to manage Workers, D1, Rate Limiting, domains, and Access.
- A public Customer hostname and a separate Merchant hostname selected under a Cloudflare-managed domain.
- LINE Official Account, Messaging API channel, Merchant recipient ID, and reviewed quota/pricing.
- No `.dev.vars`, development bypass, real secret, or real identifier in Git or the build artifact.

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

## Production D1 creation

During an authorized CP8 release only:

```powershell
npx wrangler d1 create chi-zha-de-ordering-production --location=apac
```

Record the returned real database ID. Add it to a production-specific `DB` binding with `binding = DB` and the production database name. Do not replace the ID with a placeholder and do not point production at the local database name.

## Migration procedure

Migrations are sequential and forward-applied. Migration `0001` creates the required single-store `吃炸的` settings row. `seeds/development.sql` is disposable local Menu fixture data and must never run against production.

```powershell
npx wrangler d1 migrations list DB --remote --env production
npx wrangler d1 time-travel info DB --env production
npx wrangler d1 migrations apply DB --remote --env production
npx wrangler d1 migrations list DB --remote --env production
```

Save the pre-migration Time Travel bookmark. Verify tables, indexes, the public lookup-token unique index, Order idempotency uniqueness, notification intent uniqueness, and `last_attempt_at`. Prepare and review a separate one-time production Menu SQL file with real products/prices; execute it only after approval. Query Store/Menu read-only before opening Customer traffic.

## Configuration

Production non-secret configuration must include:

- Real production D1 ID bound as `DB`.
- Production Rate Limiting namespace bound as `ORDER_RATE_LIMITER`.
- `NOTIFICATION_PROVIDER=line`.
- Exact `MERCHANT_HOSTNAME` for the Access-protected hostname.
- Exact `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` for the Merchant Access application.

`MERCHANT_DEV_BYPASS` and `PUBLIC_WRITE_RATE_LIMIT_DEV_BYPASS` must be absent. Review the generated Worker bundle/config before release.

## Secrets

Treat both LINE values as deployment-managed confidential configuration:

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_MERCHANT_RECIPIENT_ID`

Do not commit them or pass them on a command line. After the Worker resource exists and only during an authorized release, use an interactive secret command such as:

```powershell
npx wrangler versions secret put LINE_CHANNEL_ACCESS_TOKEN --env production
npx wrangler versions secret put LINE_MERCHANT_RECIPIENT_ID --env production
```

`wrangler secret put` creates and deploys a Worker version immediately; prefer the version-scoped command when preparing a controlled release. Confirm secrets are absent from logs, API responses, notification errors, source, `.env`, build output, and documentation.

## Cloudflare Access

- Customer: `order.<domain>` remains public.
- Merchant: `merchant.<domain>` is a self-hosted Cloudflare Access application covering the entire Merchant hostname, including the UI and `/api/merchant/*`.
- Configure the Worker guard with that exact Merchant hostname, Access team issuer, and application audience.
- The guard accepts an Access assertion only after exact-hostname matching and cryptographic JWT signature/issuer/audience validation. An Access-looking header on another hostname is untrusted.
- Block or redirect `/merchant` on the Customer hostname. The API guard must still return `403` there.
- Disable the Worker's `workers.dev` production route when practical. Otherwise explicitly protect it and preview URLs, and verify Merchant APIs fail closed on every alternate route/domain.
- Test unauthenticated, authenticated, expired-token, forged-header, wrong-audience, Customer-host, `workers.dev`, and preview access before launch.

Do not protect the entire shared Worker with a Worker-level Access policy because that would also require Customer authentication.

## Custom domain and alternate exposure

Attach the same reviewed Worker release to the public Customer and Access-protected Merchant hostnames only. Inventory Domains & Routes after deployment. Confirm no old route, alternate Custom Domain, `workers.dev` URL, or preview deployment can bypass the Merchant hostname/Access boundary.

## Deployment

Only after D1, secrets, Rate Limiting, Access, hostnames, and rollback data are ready:

```powershell
npx wrangler deploy --env production
npx wrangler deployments list --env production
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

Record the previous known-good version before deployment. If the new application is unhealthy and the prior code is compatible with the current D1 schema:

```powershell
npx wrangler deployments list --env production
npx wrangler rollback <previous-version-id> --env production
```

Re-run health, Customer read, and Access-authenticated Merchant smoke checks. Worker rollback does not revert D1, bindings, secrets, Access, routes, or data.

### Database recovery

Prefer a reviewed forward corrective migration. Before any risky migration, record the D1 Time Travel bookmark. If data/schema restoration is necessary, stop writes, identify the precise pre-change bookmark, obtain separate destructive-operation approval, and use D1 Time Travel according to Cloudflare's current procedure. Restoring D1 overwrites database state and is independent of Worker rollback; never automate it as part of application rollback.
