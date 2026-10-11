# Large-portion delta and scheduled store closure

Base: 8a9d3f77d32bda14797ee644e2f60b0e2e3bff5b. Local implementation only.

## Bounded price patch

`production-data/set-large-portion-delta-35.sql` updates only option 28 / group 7 / item 4 (鹹酥雞 or current 鹽酥雞) and option 30 / group 8 / item 3 (香酥魷魚), each named 大份 under 份量. Both identities must match or the entire update is a no-op. Reapplication writes nothing. It never reads or updates a base price, imports a menu, or modifies order snapshots. Backend and Cart continue to use current base price + D1 modifier delta. The companion verification SQL must return exactly two rows, both with delta 35, and quick_check=ok. The patch is not a migration and has not been applied remotely.

## State contract

Migration 0021 adds nullable `pause_reason` and `scheduled_closed_business_date`. Existing rows keep NULL; existing paused + NULL is unknown, never scheduled_closed. An applied Merchant Pause records manual_pause. Missed-order safety records missed_orders; the original auto_pause_reason remains authoritative too.

The approved soft-close policy applies only to an open weekly schedule with 17:30 opening, 23:15 closing and nullable/23:15 last-order time. Other Admin schedules keep the previous acceptance contract and automated transitions skip them. No schedule is rewritten. A service cycle starts at its opening and may continue across midnight until the next 17:30 boundary. Closed weekdays do not auto-open.

For this approved policy, 23:15 starts closure evaluation, rather than rejecting new orders by time alone. Quote and both order routes accept while Store remains accepting. After an atomic closure they return STORE_NOT_ACCEPTING_ORDERS. The existing order INSERT also checks Store accepting, state_version and schedule, so an order losing the close race writes no parent, snapshots or notification intent. An order winning first blocks closure inside the same D1 transaction.

Closing requires zero non-cancelled pending/accepted rows, even when accepted orders have passed estimated_ready_at; no new order in five minutes; valid creation timestamps; and a valid completion timestamp for completed rows of that service cycle. No order is completed or rejected by this new automation. Current source changes completed/completed_at only through the explicit Merchant complete operation. UI/history grouping and estimated pickup time never prove physical completion.

Resume requires accepting=0, scheduled_closed with an earlier service date, a matching successful scheduled closure audit, no manual Pause hold following that audit, auto_pause_reason=NULL and missed_order_count=0. Unknown, manual, legacy NULL and missed states are skipped. The extra zero-missed-count condition is conservative; it never resets the counter.

Both transitions reuse the existing immutable store_state_events, audit actor hashing and atomic D1 batch pattern. State and version are checked inside INSERT; successful writes increment state_version once. Deterministic per-service-date/action UUIDs prevent duplicate transitions. Failed eligibility/CAS does not reserve the operation ID, so a later minute can retry. Audit failure rolls back the transaction. A manual Pause recorded as already_target while scheduled-closed blocks automatic opening, including after a busy-mode version change. After competing transitions, stale manual actions retain the existing 409/retry contract.

## Cron and operational limitations

The existing `* * * * *` Cron is retained; `30 9 * * *` adds Taipei 17:30. Both run the same idempotent evaluator. Current time and scheduled service-cycle identity are checked; previous-cycle deliveries and delays of 24 hours or more are skipped. The minute Cron provides recovery within the current eligible opening window. Unanswered-order maintenance runs before closure evaluation; daily sold-out maintenance is retained separately.

Accepted orders past their estimate remain historical UI entries, with a completion button wired to the existing authenticated Merchant complete workflow. They block closure until the Merchant explicitly confirms actual completion. No estimated time or historical grouping completes them automatically. This completion action and the Customer soft-closing time label are the only UI behaviors changed, directly supporting safe closure. Release review must address outstanding accepted work; this patch does not clear it. The Customer hours panel labels 23:15 as earliest closure for the approved schedule, and explains that outstanding/recent orders can extend service. Other configured cutoffs retain their last-order label.

No Production D1 mutation, version upload, deployment, traffic change or Secret/Access edit was performed. Before any future deployment, authorize/apply migration 0021 and the bounded data patch separately, verify operational reasons and real outstanding work, and preserve a schema-compatible rollback path. WAV/gain 6.0/fallback 0.22, PWA, Web Push and authentication are unchanged.

Physical iPhone/PWA verification is not a completion gate for this task. Strict missing-header refusal remains unchanged; older Safari compatibility remains a documented inherited risk. Automated Edge and WebKit emulation cover local Online/On-site create/cancel flows.
