ALTER TABLE store_settings ADD COLUMN busy_mode INTEGER NOT NULL DEFAULT 0 CHECK (busy_mode IN (0, 1));
ALTER TABLE store_settings ADD COLUMN missed_order_count INTEGER NOT NULL DEFAULT 0 CHECK (missed_order_count >= 0);
ALTER TABLE store_settings ADD COLUMN auto_pause_reason TEXT CHECK (auto_pause_reason IS NULL OR auto_pause_reason = 'missed_orders');

ALTER TABLE orders ADD COLUMN rejection_reason TEXT CHECK (
	rejection_reason IS NULL OR rejection_reason IN ('merchant_rejected', 'auto_rejected_unanswered')
);

CREATE TABLE store_busy_mode_events (
	operation_id TEXT PRIMARY KEY,
	request_fingerprint TEXT NOT NULL,
	target_busy_mode INTEGER NOT NULL CHECK (target_busy_mode IN (0, 1)),
	expected_busy_mode INTEGER NOT NULL CHECK (expected_busy_mode IN (0, 1)),
	expected_state_version INTEGER NOT NULL,
	to_busy_mode INTEGER NOT NULL CHECK (to_busy_mode IN (0, 1)),
	to_state_version INTEGER NOT NULL,
	outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'already_target', 'stale')),
	actor_subject_hash TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE TABLE order_auto_rejection_events (
	order_id TEXT PRIMARY KEY REFERENCES orders(id),
	rejected_at TEXT NOT NULL,
	counted INTEGER NOT NULL DEFAULT 0 CHECK (counted IN (0, 1))
);

CREATE INDEX idx_orders_pending_auto_reject
	ON orders(status, estimated_ready_at, created_at)
	WHERE status = 'pending';

-- These historical options remain readable in Order snapshots but are no longer valid
-- for a new Quote or Order.
UPDATE modifier_options
SET is_active = 0
WHERE (id = 17 AND name = '不加調味' AND modifier_group_id = 5)
	OR (id = 20 AND name = '不加調味' AND modifier_group_id = 6);
