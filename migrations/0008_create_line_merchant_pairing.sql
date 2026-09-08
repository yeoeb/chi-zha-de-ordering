CREATE TABLE line_merchant_binding (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	recipient_user_id TEXT NOT NULL CHECK (
		length(recipient_user_id) = 33
		AND substr(recipient_user_id, 1, 1) = 'U'
		AND substr(recipient_user_id, 2) NOT GLOB '*[^0-9A-Fa-f]*'
	),
	paired_at TEXT NOT NULL CHECK (length(trim(paired_at)) > 0),
	updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
);

CREATE TABLE line_merchant_pairing_challenge (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	code_hash TEXT NOT NULL CHECK (
		length(code_hash) = 64
		AND code_hash NOT GLOB '*[^0-9a-f]*'
	),
	expires_at TEXT NOT NULL CHECK (length(trim(expires_at)) > 0),
	consumed_at TEXT,
	created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0)
);
