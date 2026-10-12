-- Independent activation state. Never activate a Worker or infer Store state.
CREATE TABLE scheduler_activation_events (
 id TEXT PRIMARY KEY,
 operation_id TEXT NOT NULL UNIQUE,
 request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint)=64),
 expected_state_version INTEGER NOT NULL,
 from_enabled INTEGER NOT NULL CHECK (from_enabled IN (0,1)),
 to_enabled INTEGER NOT NULL CHECK (to_enabled IN (0,1)),
 from_approved_version_id TEXT,
 to_approved_version_id TEXT,
 from_state_version INTEGER NOT NULL,
 to_state_version INTEGER NOT NULL,
 outcome TEXT NOT NULL CHECK (outcome IN ('applied','already_target','stale')),
 actor_subject_hash TEXT NOT NULL CHECK (length(actor_subject_hash)=64),
 reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 200),
 worker_version TEXT,
 created_at TEXT NOT NULL,
 CHECK ((to_enabled=0 AND to_approved_version_id IS NULL) OR
  (to_enabled=1 AND to_approved_version_id IS NOT NULL AND length(to_approved_version_id)=36)),
 CHECK (typeof(from_state_version)='integer' AND from_state_version BETWEEN 0 AND 9007199254740991),
 CHECK (typeof(to_state_version)='integer' AND to_state_version BETWEEN 0 AND 9007199254740991),
 CHECK ((outcome='applied' AND to_state_version=from_state_version+1 AND expected_state_version=from_state_version)
  OR (outcome<>'applied' AND to_state_version=from_state_version))
);
CREATE TABLE scheduler_activation (
 id INTEGER PRIMARY KEY CHECK (id=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK (typeof(enabled)='integer' AND enabled IN (0,1)),
 approved_version_id TEXT DEFAULT NULL,
 state_version INTEGER NOT NULL DEFAULT 0 CHECK (typeof(state_version)='integer' AND state_version BETWEEN 0 AND 9007199254740991),
 last_operation_id TEXT REFERENCES scheduler_activation_events(operation_id),
 updated_at TEXT,
 CHECK ((enabled=0 AND approved_version_id IS NULL) OR
  (enabled=1 AND approved_version_id IS NOT NULL AND length(approved_version_id)=36 AND last_operation_id IS NOT NULL))
);
INSERT INTO scheduler_activation(id) VALUES(1);
