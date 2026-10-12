# 吃炸的並行 hostname migration

Primary target: `https://chizhade.com` (Owner selected apex domain).
Compatibility origin: `https://chi-zha-de-ordering.yeoeb55688.workers.dev`.
Baseline: source `94f6f7bb36a4298a9e715b520c4039bc404952ee`, Worker `c0aa241e-b3a3-435a-98a2-317a3e000cea` at 100%.

## Runtime configuration

Keep `MERCHANT_HOSTNAME` and `ADMIN_HOSTNAME` at the old hostname.
Add explicit comma-separated `MERCHANT_HOSTNAMES` and `ADMIN_HOSTNAMES`, each containing exactly the old hostname and `chizhade.com`.
Hostname membership uses exact Set membership. Mutations require the exact HTTPS Origin, the same request Origin, and `Sec-Fetch-Site: same-origin`. Cross-host mutations are rejected even when both hosts are configured.
Keep existing Merchant and Admin Access audiences, team domains, policies, VAPID keys, and VAPID subject.

## Access prerequisite

CLI API discovery returned no readable existing applications, and `/access/organizations` returned 403 / 10000. Existing old-host login redirects still report distinct Merchant and Admin audiences. Do not infer that Access is absent or replace these applications.

In Cloudflare Zero Trust → Access → Applications, extend the existing Merchant application whose audience is `0b41555c46401f25d421053db77ca92f2ee8e57e91a32f647b2aa6fdd08928b4` with:

- `chizhade.com/merchant*`
- `chizhade.com/api/merchant/*`

Extend the existing Admin application whose audience is `39e998a811357e4df04ff06470dff3abda88929af9e4839fc46ce756cb24805c` with:

- `chizhade.com/admin*`
- `chizhade.com/api/admin/*`

Retain both old-host paths in each application. Keep audiences, existing allow/include/require/exclude policies, identity providers, and session settings. Never add bypass or permit the Merchant audience for Admin.
Verify unauthenticated requests to all four new paths redirect to the appropriate existing Access audience before advertising the new origin.

## Custom Domain

The `chizhade.com` zone is active and belongs to the configured account. No Worker Custom Domain was present during the audit.
Attach the apex hostname to the existing `chi-zha-de-ordering` Worker only after the Access prerequisite is established.
Dashboard: Workers & Pages → chi-zha-de-ordering → Settings / Domains & Routes → Add Custom Domain → `chizhade.com`.
Retain workers.dev enabled. Cloudflare should manage the Custom Domain DNS/certificate; do not create a guessed DNS record.

## Relative client and push behavior

Frontend API URLs and navigation, manifest id/scope, registration `/service-worker.js`, Web Push payload `/merchant`, and notificationclick are relative/same-origin and remain unchanged.
The existing manifest is Merchant-oriented (`start_url: /merchant`); this migration does not introduce a separate Customer PWA. Test installation/open on the new origin with that existing behavior.
Existing QR SVG/HTML and its generator/verifier intentionally retain the working old `/onsite` URL during compatibility. New `/onsite` is separately verified; old printed QR codes remain usable.
VAPID_SUBJECT is a signing contact identifier, not the notification-click destination; keep it unchanged.
Subscriptions, browser storage, cookies and installed PWAs are origin-specific. Preserve old subscriptions and tables. On the new origin, the Merchant signs in normally and opts in to Push using the normal UI; do not copy tokens or browser context between origins.

## Release gate

Run Worker/DOM/security tests, local D1 verifiers, lint, TypeScript, PWA validation and one exact-SHA build. Upload a new Candidate at 0%. Production stays on the recorded baseline until new-domain Candidate smoke passes.
Custom Domain routing alone points to the currently active version. At 0%, Candidate API smoke needs a version override on requests; attaching a hostname alone does not switch its runtime to the Candidate. Authenticated browser verification must use normal Access login and pin the Candidate without changing global Production traffic.
Validate `/`, `/onsite`, `/merchant`, `/admin`, the corresponding GET APIs, frozen asset identity, distinct Access audiences and rejected foreign Origins. Verify old hostname remains available. Do not create a Production test Order or perform Store/Admin mutations as a smoke test.
Only after all required gates pass may Production promotion be considered. Removal of workers.dev requires a later separate decision.

Official references: [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [hostname-based Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), [Attach Worker Domain API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/).
