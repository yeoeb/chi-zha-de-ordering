# Production readiness

Deployment is not approved. `[x]` means repository/local verification is complete; production infrastructure items remain unchecked until an explicitly authorized release.

## Repository and local verification

- [x] Full automated suite and `npm run check` pass.
- [x] Empty local D1 accepts all migrations in sequence.
- [x] Required single-store configuration is separate from replaceable development Menu fixtures.
- [x] Public Order lookup uses an opaque token; internal IDs are not public contracts.
- [x] Notification intent uniqueness, retry guard, failure isolation, and sanitized errors are tested.
- [x] Wrangler deployment dry-run bundles successfully without upload.
- [x] Service Worker excludes every `/api/*` request.
- [x] Deployment and rollback runbook reviewed locally.

## Production infrastructure and release gates

- [ ] Production D1 created.
- [ ] Production D1 ID configured in the `DB` binding.
- [ ] All migrations reviewed for production.
- [ ] Pre-migration D1 Time Travel bookmark recorded.
- [ ] All migrations applied and verified remotely.
- [ ] Real Store/Menu/products/prices reviewed and inserted; development seed not used.
- [ ] Production `ORDER_RATE_LIMITER` namespace and limits configured/verified.
- [ ] Merchant hostname protected by a self-hosted Cloudflare Access application.
- [ ] `MERCHANT_HOSTNAME`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_AUD` configured and verified.
- [ ] Merchant production guard tested with valid, missing, forged, expired, and wrong-audience context.
- [ ] `workers.dev`, preview, Custom Domain, old route, and Customer-host Merchant exposure reviewed.
- [ ] `MERCHANT_DEV_BYPASS` and `PUBLIC_WRITE_RATE_LIMIT_DEV_BYPASS` absent from production and build output.
- [ ] No alternate unprotected Merchant route exists.
- [ ] Final PWA icons reviewed and placeholder artwork replaced if needed.
- [ ] Manifest and standalone installability verified over HTTPS.
- [ ] Service Worker static caching and live API boundary verified in production.
- [ ] LINE Official Account and Messaging API channel configured.
- [ ] `LINE_CHANNEL_ACCESS_TOKEN` stored as a Cloudflare Secret.
- [ ] Merchant LINE recipient stored as deployment-managed confidential configuration.
- [ ] LINE quota/pricing understood.
- [ ] Real LINE smoke explicitly authorized and completed.
- [ ] Notification failure and Merchant retry path verified against staging configuration.
- [ ] Production secrets/configuration and PII/logging reviewed.
- [ ] Production runtime smoke complete for Customer and Access-authenticated Merchant flows.
- [ ] Previous Worker version recorded and rollback procedure reviewed.
