# Production readiness

Deployment is not approved. `[x]` means the corresponding local or explicitly authorized remote gate is complete; unchecked items still require later approval or live verification.

## Repository and local verification

- [x] Full automated suite and `npm run check` pass.
- [x] Empty local D1 accepts all migrations in sequence.
- [x] Required single-store configuration is separate from replaceable development Menu fixtures.
- [x] Public Order lookup uses an opaque token; internal IDs are not public contracts.
- [x] Notification intent uniqueness, retry guard, failure isolation, and sanitized errors are tested.
- [x] LINE is optional at Worker startup; the first release may explicitly use the disabled provider without affecting Order durability. Fake delivery requires the explicit development bypass.
- [x] Wrangler deployment dry-run bundles successfully without upload.
- [x] Service Worker excludes every `/api/*` request.
- [x] Deployment and rollback runbook reviewed locally.

## Production infrastructure and release gates

- [x] Production D1 `chi-zha-de-db` created in APAC.
- [x] Production D1 ID configured in the `DB` binding.
- [x] All seven migrations reviewed for production.
- [x] Pre-migration D1 Time Travel recovery information recorded.
- [x] All migrations applied and verified remotely.
- [x] Human-approved Store/Menu configuration inserted; development seed not used; store remains paused.
- [x] Production `ORDER_RATE_LIMITER` namespace and limits configured and verified by dry-run.
- [x] Merchant workers.dev paths protected by a self-hosted Cloudflare Access application (manual dashboard evidence accepted).
- [x] `MERCHANT_HOSTNAME`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_AUD` configured and verified by dry-run.
- [ ] Merchant production guard tested with valid, missing, forged, expired, and wrong-audience context.
- [x] workers.dev path exposure reviewed; preview URLs disabled; no Custom Domain or deployed old route exists.
- [x] `MERCHANT_DEV_BYPASS` and `PUBLIC_WRITE_RATE_LIMIT_DEV_BYPASS` absent from deployment configuration.
- [x] No configured alternate Merchant route exists before first deployment.
- [ ] First Worker deployment completed and version/deployment identifiers recorded.
- [ ] Custom Domain selected, configured, and verified for final production use.
- [ ] Final PWA icons reviewed and placeholder artwork replaced if needed.
- [ ] Manifest and standalone installability verified over HTTPS.
- [ ] Service Worker static caching and live API boundary verified in production.
- [ ] LINE Official Account and Messaging API channel configured.
- [x] First-deployment notification mode explicitly set to `disabled`; `fake` is absent.
- [ ] `LINE_CHANNEL_ACCESS_TOKEN` stored as a Cloudflare Secret when Mode B (`line`) is enabled.
- [ ] Merchant LINE recipient stored as deployment-managed non-secret confidential configuration when Mode B is enabled.
- [ ] LINE quota/pricing understood.
- [ ] Real LINE smoke explicitly authorized and completed.
- [ ] Notification failure and Merchant retry path verified against staging configuration.
- [x] Pre-deploy configuration and PII/logging boundaries reviewed; no real LINE secret is configured.
- [ ] Production runtime smoke complete for Customer and Access-authenticated Merchant flows.
- [x] Confirmed no previous Worker version exists; first-deployment recovery and later-version rollback procedures reviewed.
