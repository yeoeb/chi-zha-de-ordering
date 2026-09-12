CREATE TABLE notification_deliveries_web_push (
	id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
	order_id TEXT NOT NULL,
	channel TEXT NOT NULL CHECK (channel IN ('line', 'web_push')),
	event_type TEXT NOT NULL CHECK (event_type = 'new_order'),
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempt_count) = 'integer' AND attempt_count >= 0),
	last_error TEXT,
	created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
	sent_at TEXT,
	last_attempt_at TEXT,
	FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE RESTRICT ON DELETE CASCADE,
	UNIQUE (order_id, channel, event_type)
);

INSERT INTO notification_deliveries_web_push (
	id, order_id, channel, event_type, status, attempt_count,
	last_error, created_at, sent_at, last_attempt_at
)
SELECT
	id, order_id, channel, event_type, status, attempt_count,
	last_error, created_at, sent_at, last_attempt_at
FROM notification_deliveries;

DROP TABLE notification_deliveries;
ALTER TABLE notification_deliveries_web_push RENAME TO notification_deliveries;

CREATE INDEX notification_deliveries_status_idx
	ON notification_deliveries (status, created_at, id);

CREATE TABLE merchant_push_subscriptions (
	id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
	endpoint TEXT NOT NULL UNIQUE CHECK (length(trim(endpoint)) BETWEEN 1 AND 2048),
	p256dh TEXT NOT NULL CHECK (length(trim(p256dh)) BETWEEN 1 AND 512),
	auth TEXT NOT NULL CHECK (length(trim(auth)) BETWEEN 1 AND 512),
	created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
	updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
	last_success_at TEXT,
	last_failure_at TEXT
);

CREATE INDEX merchant_push_subscriptions_updated_idx
	ON merchant_push_subscriptions (updated_at DESC, id ASC);
