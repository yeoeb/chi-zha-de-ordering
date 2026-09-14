import {
	assertValidStoreState,
	MAX_STORE_STATE_VERSION,
} from "./store-settings";

export type StoreAction = "pause" | "resume";
type StoredOutcome = "applied" | "already_target" | "stale";
export type StoreOperationOutcome =
	| "APPLIED"
	| "IDEMPOTENT_REPLAY"
	| "ALREADY_IN_TARGET_STATE"
	| "STALE_STATE";

export type StoreOperationRequest = {
	operationId: string;
	expectedIsAcceptingOrders: boolean;
	expectedStateVersion: number;
};

export type StoreOperationResult = {
	operationId: string;
	action: StoreAction;
	outcome: StoreOperationOutcome;
	operation: {
		outcome: Exclude<StoreOperationOutcome, "IDEMPOTENT_REPLAY">;
		store: { is_accepting_orders: boolean };
		stateVersion: number;
		createdAt: string;
	};
	store: { is_accepting_orders: boolean };
	stateVersion: number;
	createdAt: string;
};

export type StoreOperationBindings = {
	AUDIT_ACTOR_HASH_KEY?: string;
	CF_VERSION_METADATA?: { id: string; tag?: string };
};

type StoreEventRow = {
	operationId: string;
	requestFingerprint: string;
	action: StoreAction;
	toAccepting: number;
	toStateVersion: number;
	outcome: StoredOutcome;
	createdAt: string;
};

type StoreStateRow = {
	is_accepting_orders: number;
	state_version: number;
};

export class StoreOperationError extends Error {
	constructor(
		readonly status: 400 | 409 | 500,
		readonly code: "INVALID_REQUEST" | "OPERATION_ID_CONFLICT" | "INTERNAL_ERROR",
		message: string,
	) {
		super(message);
		this.name = "StoreOperationError";
	}
}

const CANONICAL_UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function bytesToHex(bytes: ArrayBuffer) {
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
	return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function hashAuditActor(subject: string, secret: string | undefined) {
	const keyBytes = new TextEncoder().encode(secret ?? "");
	if (!subject.trim() || keyBytes.byteLength < 32 || keyBytes.byteLength > 1024) {
		throw new StoreOperationError(500, "INTERNAL_ERROR", "Store operation audit is unavailable");
	}

	const key = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(subject)));
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStoreOperationRequest(body: unknown, action: StoreAction): StoreOperationRequest {
	if (!isObject(body) || Object.keys(body).sort().join(",") !== "expectedIsAcceptingOrders,expectedStateVersion,operationId") {
		throw new StoreOperationError(400, "INVALID_REQUEST", "Invalid store operation request");
	}

	const { operationId, expectedIsAcceptingOrders, expectedStateVersion } = body;
	const expectedForAction = action === "resume" ? false : true;
	if (
		typeof operationId !== "string" ||
		!CANONICAL_UUID_V4.test(operationId) ||
		typeof expectedIsAcceptingOrders !== "boolean" ||
		expectedIsAcceptingOrders !== expectedForAction ||
		typeof expectedStateVersion !== "number" ||
		!Number.isSafeInteger(expectedStateVersion) ||
		expectedStateVersion < 0
	) {
		throw new StoreOperationError(400, "INVALID_REQUEST", "Invalid store operation request");
	}

	return { operationId, expectedIsAcceptingOrders, expectedStateVersion };
}

async function requestFingerprint(action: StoreAction, request: StoreOperationRequest) {
	return sha256(
		JSON.stringify([
			action,
			request.expectedIsAcceptingOrders,
			request.expectedStateVersion,
		]),
	);
}

function storedOutcome(event: StoreEventRow): Exclude<StoreOperationOutcome, "IDEMPOTENT_REPLAY"> {
	return event.outcome === "applied"
		? "APPLIED"
		: event.outcome === "already_target"
			? "ALREADY_IN_TARGET_STATE"
			: "STALE_STATE";
}

function publicResult(
	event: StoreEventRow,
	authoritativeStore: StoreStateRow,
	replayed = false,
): StoreOperationResult {
	assertValidStoreState({
		is_accepting_orders: event.toAccepting,
		state_version: event.toStateVersion,
	});
	assertValidStoreState(authoritativeStore);
	const operationOutcome = storedOutcome(event);
	return {
		operationId: event.operationId,
		action: event.action,
		outcome: replayed ? "IDEMPOTENT_REPLAY" : operationOutcome,
		operation: {
			outcome: operationOutcome,
			store: { is_accepting_orders: Boolean(event.toAccepting) },
			stateVersion: event.toStateVersion,
			createdAt: event.createdAt,
		},
		store: { is_accepting_orders: Boolean(authoritativeStore.is_accepting_orders) },
		stateVersion: authoritativeStore.state_version,
		createdAt: event.createdAt,
	};
}

async function readStoredOperationAndStore(db: D1Database, operationId: string) {
	const [eventResult, storeResult] = await db.batch([
		db.prepare(
			`SELECT
				operation_id AS operationId,
				request_fingerprint AS requestFingerprint,
				action,
				to_accepting AS toAccepting,
				to_state_version AS toStateVersion,
				outcome,
				created_at AS createdAt
			FROM store_state_events
			WHERE operation_id = ?`,
		).bind(operationId),
		db.prepare("SELECT is_accepting_orders, state_version FROM store_settings WHERE id = 1"),
	]);
	const event = eventResult.results[0] as StoreEventRow | undefined;
	const store = storeResult.results[0] as StoreStateRow | undefined;
	if (store) assertValidStoreState(store);
	return { event, store };
}

export async function getStoreOperationResult(db: D1Database, operationId: string) {
	if (!CANONICAL_UUID_V4.test(operationId)) {
		throw new StoreOperationError(400, "INVALID_REQUEST", "Invalid store operation request");
	}
	const { event, store } = await readStoredOperationAndStore(db, operationId);
	if (!event) return null;
	if (!store) throw new StoreOperationError(500, "INTERNAL_ERROR", "Store operation failed");
	return publicResult(event, store);
}

export async function performStoreOperation(input: {
	db: D1Database;
	action: StoreAction;
	request: StoreOperationRequest;
	actorSubject: string;
	auditActorHashKey?: string;
	cfRay?: string;
	workerVersion?: string;
	now?: Date;
}) {
	const {
		db,
		action,
		request,
		actorSubject,
		auditActorHashKey,
		cfRay,
		workerVersion,
		now = new Date(),
	} = input;
	if (Number.isNaN(now.getTime())) {
		throw new StoreOperationError(500, "INTERNAL_ERROR", "Store operation failed");
	}

	const fingerprint = await requestFingerprint(action, request);
	const actorHash = await hashAuditActor(actorSubject, auditActorHashKey);
	const target = action === "resume" ? 1 : 0;
	const expected = request.expectedIsAcceptingOrders ? 1 : 0;
	const eventId = crypto.randomUUID();
	const createdAt = now.toISOString();

	try {
		const results = await db.batch([
			db
				.prepare(
					`INSERT INTO store_state_events (
						id, operation_id, request_fingerprint, action,
						expected_accepting, expected_state_version,
						from_accepting, to_accepting,
						from_state_version, to_state_version,
						outcome, actor_subject_hash, cf_ray, worker_version, created_at
					)
					SELECT
						?, ?, ?, ?, ?, ?,
						current_accepting,
						CASE WHEN outcome = 'applied' THEN ? ELSE current_accepting END,
						current_version,
						CASE WHEN outcome = 'applied' THEN current_version + 1 ELSE current_version END,
						outcome, ?, ?, ?, ?
					FROM (
						SELECT
							is_accepting_orders AS current_accepting,
							state_version AS current_version,
							CASE
								WHEN is_accepting_orders = ? AND state_version = ? AND ? <> ? THEN 'applied'
								WHEN is_accepting_orders = ? THEN 'already_target'
								ELSE 'stale'
							END AS outcome
						FROM store_settings
						WHERE id = 1
							AND typeof(is_accepting_orders) = 'integer'
							AND is_accepting_orders IN (0, 1)
							AND typeof(state_version) = 'integer'
							AND state_version BETWEEN 0 AND ?
					)
					RETURNING
						operation_id AS operationId,
						request_fingerprint AS requestFingerprint,
						action,
						to_accepting AS toAccepting,
						to_state_version AS toStateVersion,
						outcome,
						created_at AS createdAt`,
				)
				.bind(
					eventId,
					request.operationId,
					fingerprint,
					action,
					expected,
					request.expectedStateVersion,
					target,
					actorHash,
					cfRay?.trim() || null,
					workerVersion?.trim() || null,
					createdAt,
					expected,
					request.expectedStateVersion,
					expected,
					target,
					target,
					MAX_STORE_STATE_VERSION - 1,
				),
			db
				.prepare(
					`UPDATE store_settings
					SET is_accepting_orders = ?, state_version = state_version + 1
					WHERE id = 1
						AND EXISTS (
							SELECT 1
							FROM store_state_events
							WHERE operation_id = ?
								AND outcome = 'applied'
								AND from_accepting = store_settings.is_accepting_orders
								AND from_state_version = store_settings.state_version
						)`,
				)
				.bind(target, request.operationId),
			db.prepare("SELECT is_accepting_orders, state_version FROM store_settings WHERE id = 1"),
		]);

		const event = results[0].results[0] as StoreEventRow | undefined;
		const store = results[2].results[0] as StoreStateRow | undefined;
		if (store) assertValidStoreState(store);
		const changes = results[1].meta.changes;
		const expectedChanges = event?.outcome === "applied" ? 1 : 0;
		if (!event || !store || store.is_accepting_orders !== event.toAccepting || store.state_version !== event.toStateVersion) {
			throw new StoreOperationError(500, "INTERNAL_ERROR", "Store operation failed");
		}
		if (changes !== expectedChanges) {
			throw new StoreOperationError(500, "INTERNAL_ERROR", "Store operation failed");
		}

		return publicResult(event, store);
	} catch (error) {
		if (error instanceof StoreOperationError) throw error;
		const { event: existing, store } = await readStoredOperationAndStore(db, request.operationId);
		if (existing) {
			if (existing.requestFingerprint !== fingerprint) {
				throw new StoreOperationError(
					409,
					"OPERATION_ID_CONFLICT",
					"Operation ID was already used for a different request",
				);
			}
			if (!store) throw new StoreOperationError(500, "INTERNAL_ERROR", "Store operation failed");
			return publicResult(existing, store, true);
		}
		throw new StoreOperationError(500, "INTERNAL_ERROR", "Store operation failed");
	}
}
