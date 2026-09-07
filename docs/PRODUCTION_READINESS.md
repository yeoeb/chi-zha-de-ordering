# Production readiness

Deployment is not approved. Complete and verify this checklist before any public release.

- [ ] Production D1 created.
- [ ] All D1 migrations applied and verified.
- [ ] Merchant hostname/path protected by Cloudflare Access.
- [ ] `MERCHANT_HOSTNAME`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_AUD` reviewed.
- [ ] `MERCHANT_DEV_BYPASS` and `PUBLIC_WRITE_RATE_LIMIT_DEV_BYPASS` absent in production.
- [ ] No alternate unprotected Merchant route exists.
- [ ] Public Order lookup uses the opaque token and internal IDs are not public contracts.
- [ ] `ORDER_RATE_LIMITER` namespace and limits configured/reviewed for the production account.
- [ ] Final PWA icons reviewed and placeholder artwork replaced if needed.
- [ ] Manifest installability verified over HTTPS.
- [ ] Service Worker API caching boundary reviewed.
- [ ] LINE Official Account and Messaging API channel configured.
- [ ] `LINE_CHANNEL_ACCESS_TOKEN` stored as a Cloudflare Secret.
- [ ] `LINE_MERCHANT_RECIPIENT_ID` configured without committing it to source.
- [ ] LINE quota and pricing understood.
- [ ] Notification provider failure path verified without affecting Order creation.
- [ ] Production secrets and environment configuration reviewed; no credentials are hardcoded.
- [ ] `workers.dev`, preview URL, custom-domain, and customer-host Merchant exposure reviewed.
- [ ] PII/token/auth-header logging reviewed and disabled.
- [ ] Production runtime smoke passed for customer and Access-authenticated Merchant flows.
- [ ] Rollback procedure and previous Worker version are known.
