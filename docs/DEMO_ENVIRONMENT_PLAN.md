# Safe Interview Demo — Environment Isolation Plan

**Status: PLANNED / NOT DEPLOYED.** This document is a proposal and safety contract. It does **not** authorize creating Cloudflare resources, changing production Cloudflare Access, running D1 migrations remotely, or changing the live business website.

> Objective: allow interviewers to experience Customer, Merchant and Admin workflows (including **test orders and price changes**) without any path to real shop orders, customer data or store controls.

## 1. Two distinct environments

| Component | Production — real shop | Interview Demo — proposed |
| --- | --- | --- |
| URL | `https://chizhade.com/` | A **new** distinct hostname, such as `demo.chizhade.com` (not yet created) |
| Worker | `chi-zha-de-ordering` | Separate `chi-zha-de-ordering-demo` Worker/environment |
| D1 | Production DB bound as `DB` | **New empty D1 instance**, also exposed to app as binding `DB`, but with different database ID |
| Data | Real orders and customer context | Synthetic products, test orders, no production export |
| Access | Existing real Merchant/Admin apps and policies | New, independent demo Merchant/Admin apps, distinct Audience IDs and allowed emails |
| Secrets | Production VAPID/Audit/Access | Independently provisioned demo-only secrets (or disable demo Push initially) |
| Cron / scheduled mutations | Production approved schedule | **Explicitly disable demo Cron triggers by default**; never inherit/activate production scheduling unintentionally |
| Rate limiting | Production safety controls | Independent demo rate limits and abuse safeguards |
| Owner account | Real authorized shop operators | Dedicated demo reviewers/roles with explicit scope and revocation |

**The same Git repository may be the source for both deployments, but their runtime bindings, credentials, routes and data must be different.** A GitHub branch alone is **not** a data-isolation boundary.

Cloudflare documented Workers Environments create distinct Workers, and environment-specific variables/bindings are *not inherited*. D1 also supports separate environment database bindings.

References: [Workers environments](https://developers.cloudflare.com/workers/wrangler/environments/), [D1 environments](https://developers.cloudflare.com/d1/configuration/environments/), [Cloudflare Access apps](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).

## 2. Recommended reviewer access

### Public Customer demo
- A review-only QR / customer URL showing **DEMO · NOT A REAL ORDER** on every relevant checkout/status screen.
- Synthetic catalog and prices, resettable test orders, and clear disclosure that nothing will be prepared or charged.
- Reasonable anti-abuse / rate limits; reserve the option to temporarily close the public demo.

### Merchant / Admin demo
- Keep privileged roles protected by **new Cloudflare Access applications** for the demo hostname and paths.
- Grant individual reviewers only the required role and period. Email One-Time PIN (with email allowlists) is easier and safer than a shared username/password.
- Admin access is **not** implied by Merchant access. Never allow a real shop Merchant or Admin session to become an automatic demo administrator.
- Avoid publishing shared passwords, OTPs, service tokens or Access JWTs in the public repository or resume.

Do **not** give interviewers a test identity on the Production Merchant/Admin site just to display the UI.

## 3. Prevent accidental Production writes

Before deploying a demo environment, enforce all of the following:

1. **Identity assertions:** demo Worker name, host, D1 database name and database UUID must be different from Production. Abort on any match. No production-domain routes in the demo deployment.
2. **No production D1 binding:** verify both checked-in config and **actual Cloudflare Dashboard bindings**. A separate Worker accidentally bound to the production D1 still has write access.
3. **Allowlist hostnames:** `MERCHANT_HOSTNAME(S)` and `ADMIN_HOSTNAME(S)` must include the demo hostname, not grant authorization for production hostnames. Check signed demo Access Audience IDs; preserve separate Merchant and Admin permissions.
4. **Exact Origin guards:** requests are permitted only on the same demo origin. Test bad/missing Origin, Fetch Metadata, Access JWT and cross-environment requests.
5. **No dev auth bypass in deployed demo:** `MERCHANT_DEV_BYPASS`, `ADMIN_DEV_BYPASS` and public rate-limit bypass must remain disabled even for demos exposed online.
6. **Explicit Cron policy:** no automatic schedule in demo initially. The existing root `wrangler.json` includes `* * * * *`; review environment inheritance before any deploy and verify deployed triggers are empty. Also verify Scheduler Activation stays disabled.
7. **No shared push identity:** do not use production VAPID secrets or push subscriptions; disable outbound Push at first or bind only separate demo-only keys.
8. **Safe URLs and PWA assets:** check navigation, onsite QR assets, notification click URL, links and manifest so no demo control sends users to the production domain. A separate hostname isolates service-worker cache and notification scope.
9. **Migrations and seed:** create a fresh demo database, apply migrations to **only that database**, then insert synthetic data. Never copy production orders, phone numbers, tokens or secrets.
10. **Demo reset:** support explicit, isolated reset of synthetic state and sold-out flags; no scheduled SQL against production and no unaudited cleanup scripts with mutable target identity.
11. **Negative tests:** attempt demo Merchant/Admin access using unauthorized identities; verify each role has only intended permissions; ensure demo writes do not change live public Store, Menu or Order counts.
12. **Release gate:** create/review a demo-only deployment checklist and show exact Worker/D1/hostname IDs before allowing Cloudflare mutations. GitHub `main` updates and production releases stay independently authorized.

## 4. Proposed implementation phases and rough effort

| Phase | Output | Working estimate |
| --- | --- | --- |
| A — Design + configuration | Isolated environments, no production resource reuse, test-account policy | 3–6 hours |
| B — New demo D1 + safe seed | Migrations, synthetic fixtures, no real PII | 4–8 hours |
| C — Demo Access + UX | Demo-only Merchant/Admin policies, demo banner, QR/manifest/link checks | 5–12 hours |
| D — E2E + verification | Role/auth tests, ordering workflow, reset, no cross-environment writes | 5–10 hours |
| E — Deployment + acceptance | Explicitly authorized demo release, read-back bindings and smoke tests | 3–6 hours |

**Estimate: 20–42 working hours**, usually **3–7 focused workdays**, excluding unforeseen blockers and custom public-demo reset features. No implementation or deployment has yet been performed.

## 5. Why not use just a test account on Production?

Cloudflare Access controls *who* can access the APIs; it does not isolate what those APIs will write. A test Merchant on the live Worker can still change production sold-out flags, store availability or real-order transitions if authorized by the app.

Only a dedicated Worker + dedicated D1 + dedicated Access identity can safely support full interactive order/admin scenarios. A read-only screen tour (recording or anonymized screenshots) is an acceptable interim alternative.

## 6. Recruiter-facing disclosure (until demo exists)

`Live storefront: https://chizhade.com (real shop; please do not place test orders). Interactive sandbox demo: in preparation; Merchant/Admin access is restricted. Screenshots and technical documentation are available in this repository.`

When the demo is deployed and tested, replace the placeholder with the **verified exact URL**. Do not invent an address in the README before DNS/routes/deployment exist.

## 7. Maintainer note

- Updating only GitHub README/docs does not **normally** deploy Cloudflare production. However, verify external CI/CD integrations or webhooks before pushing/merging; absence of tracked GitHub Actions is not proof that no external automation exists.
- Future feature/fix work should branch from `main` and return through PRs, with a separate production release gate.
- Keep the demo honest: a synthetic catalog, synthetic orders and test credentials should always be labeled accordingly.
