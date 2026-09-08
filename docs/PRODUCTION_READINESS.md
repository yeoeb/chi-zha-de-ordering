# Production readiness

The workers.dev staging Worker is deployed while the store remains paused. `[x]` means the corresponding local or explicitly authorized remote gate is complete; unchecked items still require later approval or live verification.

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
- [x] Migrations `0001`–`0007` reviewed and applied remotely; local migration `0008` is reviewed/tested but not remotely applied.
- [x] Pre-migration D1 Time Travel recovery information recorded.
- [x] All migrations applied and verified remotely.
- [x] Human-approved Store/Menu configuration inserted; development seed not used; store remains paused.
- [x] Production `ORDER_RATE_LIMITER` namespace and limits configured and verified by dry-run.
- [x] Merchant workers.dev paths protected by a self-hosted Cloudflare Access application (manual dashboard evidence accepted).
- [x] `MERCHANT_HOSTNAME`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_AUD` configured and verified by dry-run.
- [x] Access-authenticated Merchant request passed both the path-scoped Access policy and the exact-host/signed-JWT Worker guard.
- [ ] Remaining live negative Merchant guard matrix verified for forged, expired, and wrong-audience assertions (missing/unauthenticated access is already intercepted).
- [x] workers.dev path exposure reviewed; preview URLs disabled; no Custom Domain or deployed old route exists.
- [x] `MERCHANT_DEV_BYPASS` and `PUBLIC_WRITE_RATE_LIMIT_DEV_BYPASS` absent from deployment configuration.
- [x] No configured alternate Merchant route exists before first deployment.
- [x] First Worker deployment completed and version/deployment identifiers recorded.
- [ ] Custom Domain selected, configured, and verified for final production use.
- [ ] Final PWA icons reviewed and placeholder artwork replaced if needed.
- [x] Manifest, Service Worker, and required 192/512 icons reachable over HTTPS.
- [ ] Standalone installability verified on a supported device/browser.
- [ ] Service Worker static caching and live API boundary verified in production.
- [ ] LINE Official Account and Messaging API channel configured.
- [x] First-deployment notification mode explicitly set to `disabled`; `fake` is absent.
- [ ] `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_CHANNEL_SECRET` stored as version-managed Cloudflare Secrets when Mode B (`line`) is enabled.
- [ ] Migration `0008_create_line_merchant_pairing.sql` explicitly approved, recovery bookmark recorded, applied remotely, and verified.
- [ ] Merchant LINE recipient securely paired into D1 through an Access-authenticated one-time challenge and signed LINE webhook.
- [ ] LINE quota/pricing understood.
- [ ] Real LINE smoke explicitly authorized and completed.
- [ ] Notification failure and Merchant retry path verified against staging configuration.
- [x] Pre-deploy configuration and PII/logging boundaries reviewed; no real LINE secret is configured.
- [x] Read-only staging smoke complete for public Customer routes and Access-authenticated Merchant UI/API.
- [ ] Mutating production runtime smoke complete under a separately approved controlled Order scenario.
- [x] First-deployment recovery was reviewed before bootstrap; the current first version has no earlier rollback target, and later-version rollback procedures are documented.
- [x] Gate 14 LINE provider, secret, recipient acquisition, and no-send verification plan reviewed; no real LINE action occurred.
- [x] Gate 15A locally implements signature-verified, one-time-code Merchant pairing without exposing the recipient ID.
- [ ] Merchant recipient paired in staging without exposing it in Git, chat, logs, shell history, or API responses.
- [ ] Non-public provider-level diagnostic seam reviewed for the one controlled LINE send; no temporary public test endpoint added.
- [ ] LINE ambiguous-response duplicate risk reviewed; D1 prevents duplicate intents but the current outbound push has no provider-level exactly-once guarantee.
- [x] Stale Merchant local-only/unauthenticated banner updated to reflect the authenticated management surface.
