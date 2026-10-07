# Cutoff and onsite submission fix QA

## Contract and implementation

Online `/api/orders` and On-site `/api/onsite/orders` share `createOrder`. Previously that service checked Store accepting but did not enforce the configured schedule or last-order cutoff. Quote had the same gap.

`assertOrderAcceptanceWindow` now validates the D1 weekly schedule and last-order time in Quote and authoritative creation. The existing opening-cycle business-day helper supplies the service-day identity; remaining in Tuesday's service day at Wednesday 00:30 does not extend its order window. Opening is inclusive and the earlier of closing/cutoff is exclusive. Missing/malformed configuration fails closed. Local seed and deterministic test schedule use Asia/Taipei, Monday closed, Tuesday–Sunday 17:30–23:15, last-order time 23:15.

The API returns HTTP 409 with `BUSINESS_HOURS_CLOSED`, or `BUSINESS_SCHEDULE_UNAVAILABLE` for invalid configuration. The atomic order INSERT guards the schedule and cutoff values as well as existing Store/state/queue checks. Existing committed requests replay before the new-order gate; changed bodies under the same key remain conflicts. Cutoff checks do not pause Store, change state version/missed count, reset sold-out, or mutate existing orders.

## Submission regression

The reported onsite checkout messages originate from a recoverable saved order attempt whose client request hash differs from the current request. The old client branch returned before any POST, so repeated confirmation could never reconcile it. This is a shared customer client runtime issue and can affect production. The precise reason the user's original stored hash differed was not inspected.

A targeted DOM regression first reproduced the exact blocked branch. Confirmation now restores the original valid idempotency key and lets the existing backend fingerprint/replay contract decide the result. It never replaces an unknown attempt with a fresh key. Conflict and unknown failure tests retain that key across retries. The hint now accurately instructs the customer to press confirmation.

Fresh HTTP and browser submissions on the original local server had already returned 201 for both sources before this fix. Thus the reported deadlock was not attributed to cutoff, schema drift, or onsite payload rejection. Local migration state was 0001–0020; the existing local Store was accepting with a schedule, and system time was outside the future enforced window. No local seed reset was performed.

## Validation before freezing

- Full Worker: 381 tests in 33 files PASS (previous baseline 345).
- Full DOM: 240 tests in 15 files PASS (previous baseline 235).
- npm run check: lint, TypeScript, PWA verification and build PASS.
- npm run build: PASS; JS index-DN7qV8HR.js, CSS index-E_sLy8pj.css.
- Local D1 migrations: no unapplied migrations.
- Fresh D1 verifier, upgrade verifier and production-data verifier: PASS on isolated local databases.
- git diff --check: PASS.

New tests cover both sources at 17:29:59, 17:30:00, 23:14:59, 23:15:00, Wednesday 00:30, Monday 18:00, paused Store, prior quote at cutoff, missing schedule, earlier close/cutoff, schedule changes during atomic creation, idempotent replay/conflict after cutoff, and unchanged existing pending/preparing orders with completion after cutoff. Existing order-creation suites now use an explicit opening-hours fixture and Date-only fake clock rather than wall time.

## Browser QA

An isolated Miniflare D1 with all 20 migrations and local seed served the built Worker/client through localhost:8891. Edge used fresh browser contexts and an in-memory local-only injected clock; the built production bundle was not modified on disk. No production IDs, production credentials or production database were used.

At Tuesday 18:00, Online and On-site complete real UI submissions with 201. Onsite with a deliberately stale saved client hash succeeds with the original key. At 23:15 both reject a previously obtained quote with HTTP 409 BUSINESS_HOURS_CLOSED and normal Chinese business-hours text. Existing orders remain visible through the Merchant API and one can be accepted/completed after cutoff. Browser exceptions: none. Final local Store accepting=1, state_version=0, missed count=0, no auto-pause; three orders exist and rejected submissions add none.

Detailed browser evidence and screenshots are saved in this task's outputs/local-browser-qa.json and outputs/local-qa-*.png. After freezing, all required checks must be rerun on the exact commit and the final evidence saved separately.

## Production boundary

The previous SHA 4309f46d3013b44dc7a61eeb915b14cf0ae2f49a and candidate db72be8f-3840-4ed0-91ed-41129e2e978b are superseded for promotion. The authorized next action is only uploading a replacement version at effective 0% traffic, with the current production version dd0bb626-225a-4353-bf7f-cfcf6d3f0887 retained at 100%.

This cycle does not write production business hours, clean the four historical pending orders, configure cron, perform authenticated production Merchant/Admin smoke, pause/resume Store, create a production test order, alter Access/secrets, or promote. Those operational prerequisites remain for the next release gate.
