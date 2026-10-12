# Client Delivery & Quality Assurance — Chi Zha De

**Status: Evidence-based delivery checklist, not a signed acceptance certificate or a commercial SLA.**

The application was designed around the operations of a real Taiwanese fried-food shop. Technical implementation, production configuration, on-device acceptance and contractual support commitments are **different kinds of evidence**. This document deliberately keeps them separate.

**Language:** English · [繁體中文](./CLIENT_DELIVERY_ASSURANCE.md)

## 1. Acceptance evidence levels

| Label | Meaning |
| --- | --- |
| **CODE + TEST** | Source and relevant automated tests are present in this repo; not a claim of live production pass |
| **RUNBOOK** | Documented procedure, not necessarily an executed recovery drill |
| **VERIFY LIVE** | Current production identities/configuration/audits need fresh, time-stamped read-only evidence |
| **UAT PENDING** | Real store operator and device checks remain to be performed |
| **OPEN** | Missing evidence, capability or agreed policy |
| **AGREEMENT** | Requires a business/customer agreement; cannot be inferred from a GitHub repository |

## 2. Functional acceptance

| Business requirement | Repo-level evidence | Follow-up |
| --- | --- | --- |
| Customer menu, quantities, variants, checkout | `src/react-app/`, `test/customer-ordering.dom.test.tsx` | Business owner verifies the actual live catalog, prices and all selectable options |
| No duplicate submission after retries | `src/worker/order-creation.ts`, `test/order-concurrency.test.ts`, `test/order-atomicity.test.ts` | Slow network, retries and double taps on real devices |
| Server-side pricing and immutable order snapshots | `src/worker/order-creation.ts`, `test/order-creation.test.ts` | Quote-change / availability race and live-menu acceptance |
| Two-device order transitions | `src/worker/merchant-orders.ts`, `test/merchant-orders.test.ts` | Two authenticated real Merchant devices |
| Store pause, sold-out, shortage and cancel | `src/worker/store-operations.ts`, `test/order-adjustments.test.ts` | Business end-to-end rehearsal |
| On-site QR and pickup scheduling | `test/onsite-ordering.test.ts`, `test/order-scheduling.test.ts` | Real phone checkout and pickup flow in **isolated** test environment |
| Notifications and disconnection recovery | Web Push, Service Worker and Merchant polling | iOS / Android background, lock screen, mute, volume and network recovery |
| Business-day open/close scheduling | `src/worker/store-schedule.ts`, `test/scheduler-activation.test.ts` | Confirm live Worker Version, activation state and naturally executed Cron audits |

**No false substitutions:** an HTTP 200 is not enough to prove an order was atomically and correctly created; automated tests do not prove physical phones can reliably alert a shop; uploading a Worker does not prove newly gated Scheduler functionality is active.

## 3. Security, recovery and production safeguards

| Area | Present evidence | Remaining requirements |
| --- | --- | --- |
| Role separation | Cloudflare Access JWT and Merchant/Admin audience validation in `src/worker/security.ts` | Check live Access apps, domain rules and bindings for each release |
| Mutation defense | Exact-origin / Fetch Metadata checks in `src/worker/public-origin.ts` and security tests | Device compatibility and security regression checks |
| Concurrency | CAS, operation ID, audit trail, idempotency tests | Repeated/concurrent operations under representative conditions |
| Versioned release | [Deployment runbook](DEPLOYMENT_RUNBOOK.md) and [development policy](MAIN_DEVELOPMENT_POLICY.md) | Version identity, migration compatibility, rollback exercise |
| Database restore | Cloudflare D1 Time Travel capability | **Isolated restoration drill**, verified recovery point, agreed RPO/RTO; never blindly restore live D1 |
| Monitoring and alerting | In-app disconnect indicators; polling and notification repair paths | External health/error/latency alerts, escalation and responsible operator |
| Personal data | Opaque order lookup token and limited public access | Retention, notice, access/deletion procedure, log minimization and incident response |
| Peak performance | Automated ordering and concurrency tests | Synthetic load test and measured success rate/P95 latencies |
| CI / code scanning | Local npm checks documented | No tracked `.github/workflows/` at last repo audit; add CI and secret/dependency checks |
| Accessibility and mobile | Responsive app + DOM/browser checks | Real device UAT and accessibility audit; do not claim WCAG certification without evidence |

Useful references: [OWASP ASVS](https://github.com/OWASP/ASVS), [Google SRE workbook](https://sre.google/workbook/implementing-slos/), [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [Taiwan Personal Data Protection Act](https://law.moj.gov.tw/LawClass/LawAll.aspx?Pcode=I0050021).

## 4. Operating handbook — what the shop needs

### Before opening

1. Confirm the live catalog, availability, accepting-orders state and opening-day schedule.
2. Sign in on the Merchant device; check connectivity and last synchronization time.
3. Verify audible notification / Push **and** polling fallback; background notification behavior depends on the device/OS.
4. Keep an approved manual pause / fallback ordering procedure for outages.

### Incident severity (example policy, not an existing SLA)

| Severity | Example | First response |
| --- | --- | --- |
| **P0** | Duplicate real orders, inaccurate payable totals, information disclosure, inability to control accepting-orders state | Notify responsible operator, preserve evidence, consider authorized store pause, stop release changes |
| **P1** | Broken Merchant notifications, widespread API errors or inability of a user segment to order | Use manual ordering fallback, investigate D1/API/Access, assess approved rollback |
| **P2** | Cosmetic defects, images or nontransactional layout issues | Queue a fix without risky peak-time deployment |

Log incident start/detection/recovery times, impact, active Worker version and actions taken. Do not expose real customer phone numbers, credentials, tokens or private keys.

## 5. SLI / SLO / SLA — avoid unsupported promises

- **SLI:** actual order-creation success rate, API availability, P95 latency, elapsed time before Merchant notices an order and notification success rate.
- **SLO:** a *measurable* operating target agreed with the shop, with relevant alerts and a review routine.
- **SLA:** a **contractual commitment** only after both parties agree on hours, measurements, exceptions and remedies. This project does not claim a 99.9% SLA.
- **RPO/RTO:** restore-point objective and recovery-time objective; set only after evidence from an isolated exercise. Time Travel is a capability, not proof of instant or lossless recovery.

## 6. Recommended handover package

| Deliverable | Acceptance evidence |
| --- | --- |
| Operator manual | Customer, Merchant and Admin workflows; shortages, rejection, cancellation, sold-out, pause and reopening |
| Source and version identity | Git commit/release tag, dependency lockfile, reproducible local build |
| Release and rollback SOP | Reviewed Worker/D1/Access/secret identities, recovery and abort criteria; no real secrets in Git |
| Test and acceptance report | Feature → scenario → expected result → PASS/FAIL → build version, operator and date |
| Data handling & recovery | Retention/export/delete policy, isolated restore rehearsal, authorized access |
| Monitoring & support | Detection/escalation channel, incident procedure, manual fallback |
| Responsibility handoff | Business owner, maintainer, Cloudflare account ownership, domain, software license/data responsibilities |
| Maintenance and defect warranty | Coverage, response windows and exclusions agreed in writing; not automatically included in source delivery |

**Illustrative, not agreed:** the parties might negotiate a limited period to fix reproducible defects in the accepted scope at no extra cost. New features, third-party downtime, device failures and added operating expenses should be addressed separately. No actual duration or fee has been accepted here.

## 7. UAT sign-off worksheet (intentionally blank)

- Client representative / acceptance date: **NOT RECORDED**
- Release commit SHA and deployed Worker Version: **VERIFY LIVE**
- Actual catalog, item prices and availability: **PENDING**
- Customer online, on-site QR, cancellation, shortage flow: **PENDING**
- Two Merchant phones, notification volume, reconnect behavior: **PENDING**
- Admin authorization and product update: **PENDING**
- Naturally scheduled opening/closing and safety exception behavior: **PENDING**
- Backup restore and controlled rollback rehearsal: **PENDING**
- Operator handbook, privacy notice and maintenance contact: **PENDING**
- Customer sign-off: **NOT CLAIMED**

No developer/agent may pre-fill customer signatures or mark live UAT PASSED using only local unit tests.

## 8. Prioritized next steps

**Highest operational risk:** verify active live release; install meaningful error/uptime alerts; rehearse isolated D1 restore and Worker rollback; test Merchant operation on real devices; agree manual ordering fallback and emergency contacts.

**Next:** load-test synthetic traffic, confirm privacy notice and data lifecycle, introduce GitHub Actions CI/secret scanning, refresh historical status docs to avoid confusing past Production NO-GO with current status, add genuine privacy-safe UI captures.

**Demonstration security:** provide recruiters a separate, synthetic [demo environment](DEMO_ENVIRONMENT_PLAN.md), not Production Merchant/Admin credentials.

---

**Interview explanation:** “This system comes from a real shop’s requirements. I designed around duplicate submissions, stale prices, concurrent actions, access control and failure recovery. I distinguish tested code from real-device acceptance and live operational guarantees, and maintain explicit delivery criteria.”
