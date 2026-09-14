ALTER TABLE store_settings
	ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0 CHECK (
		typeof(state_version) = 'integer'
		AND state_version BETWEEN 0 AND 9007199254740991
	);

CREATE TABLE store_state_events (
	id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
	operation_id TEXT NOT NULL UNIQUE CHECK (length(trim(operation_id)) > 0),
	request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
	action TEXT NOT NULL CHECK (action IN ('pause', 'resume')),
	expected_accepting INTEGER NOT NULL CHECK (expected_accepting IN (0, 1)),
	expected_state_version INTEGER NOT NULL CHECK (
		typeof(expected_state_version) = 'integer'
		AND expected_state_version BETWEEN 0 AND 9007199254740991
	),
	from_accepting INTEGER NOT NULL CHECK (from_accepting IN (0, 1)),
	to_accepting INTEGER NOT NULL CHECK (to_accepting IN (0, 1)),
	from_state_version INTEGER NOT NULL CHECK (
		typeof(from_state_version) = 'integer'
		AND from_state_version BETWEEN 0 AND 9007199254740991
	),
	to_state_version INTEGER NOT NULL CHECK (
		typeof(to_state_version) = 'integer'
		AND to_state_version BETWEEN 0 AND 9007199254740991
	),
	outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'already_target', 'stale')),
	actor_subject_hash TEXT NOT NULL CHECK (length(actor_subject_hash) = 64),
	cf_ray TEXT CHECK (cf_ray IS NULL OR length(trim(cf_ray)) BETWEEN 1 AND 128),
	worker_version TEXT CHECK (
		worker_version IS NULL OR length(trim(worker_version)) BETWEEN 1 AND 128
	),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CHECK (length(trim(created_at)) > 0),
	CHECK (
		(
			outcome = 'applied'
			AND expected_accepting = from_accepting
			AND expected_state_version = from_state_version
			AND to_state_version = from_state_version + 1
			AND (
				(action = 'resume' AND from_accepting = 0 AND to_accepting = 1)
				OR (action = 'pause' AND from_accepting = 1 AND to_accepting = 0)
			)
		)
		OR (
			outcome = 'already_target'
			AND from_accepting = to_accepting
			AND from_state_version = to_state_version
			AND (
				(action = 'resume' AND to_accepting = 1)
				OR (action = 'pause' AND to_accepting = 0)
			)
		)
		OR (
			outcome = 'stale'
			AND from_accepting = to_accepting
			AND from_state_version = to_state_version
		)
	)
);

CREATE INDEX store_state_events_created_idx
	ON store_state_events (created_at DESC, id ASC);
