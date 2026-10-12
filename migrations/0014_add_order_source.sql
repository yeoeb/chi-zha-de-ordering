ALTER TABLE orders ADD COLUMN order_source TEXT NOT NULL DEFAULT 'online'
	CHECK (order_source IN ('online', 'onsite'));

CREATE INDEX orders_active_schedule_idx
	ON orders (status, order_source, estimated_ready_at, created_at, id);
