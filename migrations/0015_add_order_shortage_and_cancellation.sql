ALTER TABLE orders ADD COLUMN shortage_policy TEXT NOT NULL DEFAULT 'continue_available'
	CHECK (shortage_policy IN ('continue_available', 'cancel_entire_order'));

ALTER TABLE orders ADD COLUMN original_total_amount INTEGER
	CHECK (
		original_total_amount IS NULL OR (
			typeof(original_total_amount) = 'integer'
			AND original_total_amount >= 0
		)
	);

ALTER TABLE orders ADD COLUMN shortage_revision INTEGER NOT NULL DEFAULT 0
	CHECK (typeof(shortage_revision) = 'integer' AND shortage_revision >= 0);

ALTER TABLE orders ADD COLUMN cancelled_at TEXT;

ALTER TABLE orders ADD COLUMN cancellation_reason TEXT
	CHECK (
		cancellation_reason IS NULL OR cancellation_reason IN (
			'customer_cancelled',
			'shortage_cancelled',
			'all_items_unavailable'
		)
	);

CREATE TABLE order_item_shortages (
	order_item_id TEXT PRIMARY KEY,
	unavailable_quantity INTEGER NOT NULL
		CHECK (typeof(unavailable_quantity) = 'integer' AND unavailable_quantity > 0),
	amount_deducted INTEGER NOT NULL
		CHECK (typeof(amount_deducted) = 'integer' AND amount_deducted >= 0),
	updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
	FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE TABLE order_shortage_requests (
	id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 128),
	order_id TEXT NOT NULL,
	created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
	FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE INDEX order_shortage_requests_order_idx
	ON order_shortage_requests (order_id, created_at);

CREATE INDEX orders_customer_history_idx
	ON orders (cancelled_at, status, created_at, id);
