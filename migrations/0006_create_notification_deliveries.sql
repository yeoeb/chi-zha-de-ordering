CREATE TABLE notification_deliveries (
	id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
	order_id TEXT NOT NULL,
	channel TEXT NOT NULL CHECK (channel = 'line'),
	event_type TEXT NOT NULL CHECK (event_type = 'new_order'),
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
	last_error TEXT,
	created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
	sent_at TEXT,
	FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE RESTRICT ON DELETE CASCADE,
	UNIQUE (order_id, channel, event_type)
);

CREATE INDEX notification_deliveries_status_idx
	ON notification_deliveries (status, created_at, id);
