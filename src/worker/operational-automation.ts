import { ACTIVE_SCHEDULE_FINGERPRINT_SQL, advancePendingOnsiteOrders, createKitchenScheduleFingerprint, planBusyModeExtensions, readActiveKitchenSchedule } from "./order-scheduling";
import { hashAuditActor } from "./store-operations";
import { getStoreSettings } from "./store-settings";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type BusyOutcome = "applied" | "already_target" | "stale";

export type BusyModeRequest = {
	operationId: string;
	expectedBusyMode: boolean;
	expectedStateVersion: number;
	busyMode: boolean;
};

export class OperationalAutomationError extends Error {
	constructor(
		readonly status: 400 | 409 | 500,
		readonly code: "INVALID_REQUEST" | "OPERATION_ID_CONFLICT" | "INTERNAL_ERROR",
		message: string,
	) {
		super(message);
		this.name = "OperationalAutomationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesToHex(bytes: ArrayBuffer) {
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
	return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function roundedMinimumReadyAt(now: Date, minutes: number) {
	const boundary = 5 * 60_000;
	return new Date(Math.ceil((now.getTime() + minutes * 60_000) / boundary) * boundary).toISOString();
}

export function parseBusyModeRequest(body: unknown): BusyModeRequest {
	if (!isRecord(body) || Object.keys(body).sort().join(",") !== "busyMode,expectedBusyMode,expectedStateVersion,operationId") {
		throw new OperationalAutomationError(400, "INVALID_REQUEST", "Invalid busy mode request");
	}
	const { operationId, expectedBusyMode, expectedStateVersion, busyMode } = body;
	if (
		typeof operationId !== "string" || !UUID_V4.test(operationId) ||
		typeof expectedBusyMode !== "boolean" || typeof busyMode !== "boolean" ||
		typeof expectedStateVersion !== "number" || !Number.isSafeInteger(expectedStateVersion) ||
		expectedStateVersion < 0
	) {
		throw new OperationalAutomationError(400, "INVALID_REQUEST", "Invalid busy mode request");
	}
	return { operationId, expectedBusyMode, expectedStateVersion, busyMode };
}

type BusyEventRow = {
	operationId: string;
	requestFingerprint: string;
	targetBusyMode: number;
	toBusyMode: number;
	toStateVersion: number;
	outcome: BusyOutcome;
	createdAt: string;
};

async function busyFingerprint(request: BusyModeRequest) {
	return sha256(JSON.stringify([
		request.expectedBusyMode,
		request.expectedStateVersion,
		request.busyMode,
	]));
}

function publicBusyResult(event: BusyEventRow, replayed: boolean, extendedOrderCount: number) {
	return {
		operationId: event.operationId,
		outcome: replayed
			? "IDEMPOTENT_REPLAY"
			: event.outcome === "applied"
				? "APPLIED"
				: event.outcome === "already_target"
					? "ALREADY_IN_TARGET_STATE"
					: "STALE_STATE",
		busyMode: Boolean(event.toBusyMode),
		stateVersion: event.toStateVersion,
		extendedOrderCount,
		createdAt: event.createdAt,
	};
}

export async function performBusyModeOperation(input: {
	db: D1Database;
	request: BusyModeRequest;
	actorSubject: string;
	auditActorHashKey?: string;
	now?: Date;
}) {
	const { db, request, actorSubject, auditActorHashKey, now = new Date() } = input;
	if (Number.isNaN(now.getTime())) throw new OperationalAutomationError(500, "INTERNAL_ERROR", "Busy mode operation failed");
	const fingerprint = await busyFingerprint(request);
	const actorHash = await hashAuditActor(actorSubject, auditActorHashKey);
	const createdAt = now.toISOString();
	const target = request.busyMode ? 1 : 0;
	const expected = request.expectedBusyMode ? 1 : 0;
	const minimumReadyAt = roundedMinimumReadyAt(now, 30);

	const existing = await db.prepare(
		`SELECT operation_id AS operationId, request_fingerprint AS requestFingerprint,
			target_busy_mode AS targetBusyMode, to_busy_mode AS toBusyMode,
			to_state_version AS toStateVersion, outcome, created_at AS createdAt
		FROM store_busy_mode_events WHERE operation_id = ?`,
	).bind(request.operationId).first<BusyEventRow>();
	if (existing) {
		if (existing.requestFingerprint !== fingerprint) {
			throw new OperationalAutomationError(409, "OPERATION_ID_CONFLICT", "Operation ID was already used");
		}
		return publicBusyResult(existing, true, 0);
	}
	const [schedule, store] = await Promise.all([readActiveKitchenSchedule(db), getStoreSettings(db)]);
	if (!store) throw new OperationalAutomationError(500, "INTERNAL_ERROR", "Store settings not found");
	const fingerprintBefore = createKitchenScheduleFingerprint(schedule);
	const extensions = request.busyMode ? planBusyModeExtensions(schedule, {
		basePrepMinutes: store.base_prep_minutes, normalOrderMinutes: store.normal_order_minutes,
		specialExtraMinutes: store.special_extra_minutes,
	}, new Date(minimumReadyAt)) : [];
	const extensionCases = extensions.map(() => "WHEN ? THEN ?").join(" ");

	try {
		const results = await db.batch([
			db.prepare(
				`INSERT INTO store_busy_mode_events (
					operation_id, request_fingerprint, target_busy_mode,
					expected_busy_mode, expected_state_version, to_busy_mode,
					to_state_version, outcome, actor_subject_hash, created_at
				)
				SELECT ?, ?, ?, ?, ?,
					CASE WHEN outcome = 'applied' THEN ? ELSE current_busy END,
					CASE WHEN outcome = 'applied' THEN current_version + 1 ELSE current_version END,
					outcome, ?, ?
				FROM (
					SELECT busy_mode AS current_busy, state_version AS current_version,
						CASE
							WHEN busy_mode = ? THEN 'already_target'
							WHEN busy_mode = ? AND state_version = ? AND ${ACTIVE_SCHEDULE_FINGERPRINT_SQL} = ? THEN 'applied'
							ELSE 'stale'
						END AS outcome
					FROM store_settings WHERE id = 1
				)
				RETURNING operation_id AS operationId, request_fingerprint AS requestFingerprint,
					target_busy_mode AS targetBusyMode, to_busy_mode AS toBusyMode,
					to_state_version AS toStateVersion, outcome, created_at AS createdAt`,
			).bind(
				request.operationId, fingerprint, target, expected, request.expectedStateVersion,
				target, actorHash, createdAt, target, expected, request.expectedStateVersion, fingerprintBefore,
			),
			db.prepare(
				`UPDATE store_settings
				SET busy_mode = ?, state_version = state_version + 1
				WHERE id = 1 AND EXISTS (
					SELECT 1 FROM store_busy_mode_events
					WHERE operation_id = ? AND outcome = 'applied'
						AND expected_busy_mode = store_settings.busy_mode
						AND expected_state_version = store_settings.state_version
				)`,
			).bind(target, request.operationId),
			db.prepare(
				`UPDATE orders SET estimated_ready_at = ${extensions.length ? `CASE id ${extensionCases} ELSE estimated_ready_at END` : "estimated_ready_at"}
				WHERE status = 'pending' AND order_source = 'online'
					AND id IN (${extensions.length ? extensions.map(() => "?").join(",") : "NULL"})
					AND ${ACTIVE_SCHEDULE_FINGERPRINT_SQL} = ?
					AND EXISTS (
						SELECT 1 FROM store_busy_mode_events
						WHERE operation_id = ? AND outcome = 'applied'
					)`,
			).bind(...extensions.flatMap((extension) => [extension.id, extension.to]), ...extensions.map((extension) => extension.id), fingerprintBefore, request.operationId),
		]);
		const event = results[0].results[0] as BusyEventRow | undefined;
		if (!event) throw new OperationalAutomationError(500, "INTERNAL_ERROR", "Busy mode operation failed");
		return publicBusyResult(event, false, results[2].meta.changes);
	} catch (error) {
		if (error instanceof OperationalAutomationError) throw error;
		const replay = await db.prepare(
			`SELECT operation_id AS operationId, request_fingerprint AS requestFingerprint,
				target_busy_mode AS targetBusyMode, to_busy_mode AS toBusyMode,
				to_state_version AS toStateVersion, outcome, created_at AS createdAt
			FROM store_busy_mode_events WHERE operation_id = ?`,
		).bind(request.operationId).first<BusyEventRow>();
		if (replay && replay.requestFingerprint === fingerprint) return publicBusyResult(replay, true, 0);
		throw new OperationalAutomationError(500, "INTERNAL_ERROR", "Busy mode operation failed");
	}
}

export async function processDueAutoRejections(db: D1Database, now = new Date()) {
	if (Number.isNaN(now.getTime())) throw new RangeError("now must be valid");
	const timestamp = now.toISOString();
	const { results: dueOrders } = await db.prepare(
		`SELECT id FROM orders
		WHERE status = 'pending'
			AND datetime(created_at, '+5 minutes') <= datetime(?)
			AND datetime(estimated_ready_at, '-15 minutes') <= datetime(?)
		ORDER BY estimated_ready_at ASC, created_at ASC, id ASC`,
	).bind(timestamp, timestamp).all<{ id: string }>();
	const rejectedOrderIds: string[] = [];

	for (const candidate of dueOrders) {
		const results = await db.batch([
			db.prepare(
				`UPDATE orders
				SET status = 'rejected', rejected_at = ?, rejection_reason = 'auto_rejected_unanswered'
				WHERE id = ? AND status = 'pending'
					AND datetime(created_at, '+5 minutes') <= datetime(?)
					AND datetime(estimated_ready_at, '-15 minutes') <= datetime(?)`,
			).bind(timestamp, candidate.id, timestamp, timestamp),
			db.prepare(
				`INSERT INTO order_auto_rejection_events (order_id, rejected_at, counted)
				SELECT id, ?, 0 FROM orders
				WHERE id = ? AND status = 'rejected'
					AND rejection_reason = 'auto_rejected_unanswered' AND rejected_at = ?
				ON CONFLICT(order_id) DO NOTHING`,
			).bind(timestamp, candidate.id, timestamp),
			db.prepare(
				`UPDATE store_settings SET
					missed_order_count = missed_order_count + 1,
					is_accepting_orders = CASE
						WHEN is_accepting_orders = 1 AND missed_order_count + 1 >= 3 THEN 0
						ELSE is_accepting_orders END,
					auto_pause_reason = CASE
						WHEN is_accepting_orders = 1 AND missed_order_count + 1 >= 3 THEN 'missed_orders'
						ELSE auto_pause_reason END,
					state_version = state_version + 1
				WHERE id = 1 AND EXISTS (
					SELECT 1 FROM order_auto_rejection_events
					WHERE order_id = ? AND counted = 0
				)`,
			).bind(candidate.id),
			db.prepare(
				`UPDATE order_auto_rejection_events SET counted = 1
				WHERE order_id = ? AND counted = 0`,
			).bind(candidate.id),
		]);
		if (results[0].meta.changes === 1) rejectedOrderIds.push(candidate.id);
	}

	if (rejectedOrderIds.length > 0) {
		const store = await getStoreSettings(db);
		if (store) {
			await advancePendingOnsiteOrders(db, {
				basePrepMinutes: store.base_prep_minutes,
				normalOrderMinutes: store.normal_order_minutes,
				specialExtraMinutes: store.special_extra_minutes,
			}, now);
		}
	}
	return { rejectedOrderIds };
}
