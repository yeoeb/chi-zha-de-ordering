import { advancePendingOnsiteOrders } from "./order-scheduling";
import { getOrderSnapshotById, getOrderSnapshotByPublicLookupToken } from "./merchant-orders";
import { getStoreSettings } from "./store-settings";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

type ShortageRequest = {
	requestId: string;
	items: Array<{ orderItemId: string; quantity: number }>;
};

type AdjustmentErrorCode =
	| "INVALID_SHORTAGE_REQUEST"
	| "ORDER_NOT_FOUND"
	| "ORDER_NOT_ADJUSTABLE"
	| "ORDER_ITEM_NOT_FOUND"
	| "INVALID_SHORTAGE_QUANTITY"
	| "ORDER_ADJUSTMENT_CONFLICT"
	| "CANCELLATION_NOT_ALLOWED"
	| "CANCELLATION_DEADLINE_PASSED";

export class OrderAdjustmentError extends Error {
	constructor(
		readonly status: 400 | 404 | 409 | 422,
		readonly code: AdjustmentErrorCode,
		message: string,
	) {
		super(message);
		this.name = "OrderAdjustmentError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseShortageRequest(value: unknown): ShortageRequest {
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => !["requestId", "items"].includes(key)) ||
		typeof value.requestId !== "string" ||
		!REQUEST_ID_PATTERN.test(value.requestId) ||
		!Array.isArray(value.items) ||
		value.items.length === 0 ||
		value.items.length > 50
	) {
		throw new OrderAdjustmentError(400, "INVALID_SHORTAGE_REQUEST", "Shortage request is invalid");
	}

	const seen = new Set<string>();
	const items = value.items.map((candidate) => {
		if (
			!isRecord(candidate) ||
			Object.keys(candidate).some((key) => !["orderItemId", "quantity"].includes(key)) ||
			typeof candidate.orderItemId !== "string" ||
			candidate.orderItemId.length < 1 ||
			candidate.orderItemId.length > 128 ||
			typeof candidate.quantity !== "number" ||
			!Number.isSafeInteger(candidate.quantity) ||
			candidate.quantity <= 0 ||
			seen.has(candidate.orderItemId)
		) {
			throw new OrderAdjustmentError(400, "INVALID_SHORTAGE_REQUEST", "Shortage line is invalid");
		}
		seen.add(candidate.orderItemId);
		return { orderItemId: candidate.orderItemId, quantity: candidate.quantity };
	});

	return { requestId: value.requestId, items };
}

async function createShortageRequestFingerprint(request: ShortageRequest) {
	const canonicalItems = [...request.items]
		.sort((left, right) => left.orderItemId.localeCompare(right.orderItemId))
		.map(({ orderItemId, quantity }) => ({ orderItemId, quantity }));
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify({ items: canonicalItems })),
	);
	return [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

async function rescheduleAfterCapacityRelease(db: D1Database, now: Date) {
	try {
		const store = await getStoreSettings(db);
		if (!store) return;
		await advancePendingOnsiteOrders(db, {
			basePrepMinutes: store.base_prep_minutes,
			normalOrderMinutes: store.normal_order_minutes,
			specialExtraMinutes: store.special_extra_minutes,
		}, now);
	} catch {
		// The completed state change remains authoritative. A stale schedule is safer
		// than moving a promised deadline without a current schedule fingerprint.
	}
}

export async function markOrderShortage(
	db: D1Database,
	orderId: string,
	request: ShortageRequest,
	now: Date,
) {
	const requestFingerprint = await createShortageRequestFingerprint(request);
	const replay = await db.prepare(
		"SELECT order_id AS orderId, request_fingerprint AS requestFingerprint FROM order_shortage_requests WHERE id = ?",
	).bind(request.requestId).first<{ orderId: string; requestFingerprint: string }>();
	if (replay) {
		if (replay.orderId !== orderId || replay.requestFingerprint !== requestFingerprint) {
			throw new OrderAdjustmentError(409, "ORDER_ADJUSTMENT_CONFLICT", "Request ID was already used for another adjustment");
		}
		const order = await getOrderSnapshotById(db, orderId);
		if (!order) throw new OrderAdjustmentError(404, "ORDER_NOT_FOUND", "Order not found");
		return { order, replayed: true };
	}

	const order = await db.prepare(
		`SELECT status, shortage_policy AS shortagePolicy, shortage_revision AS shortageRevision,
			total_amount AS totalAmount, cancelled_at AS cancelledAt
		FROM orders WHERE id = ?`,
	).bind(orderId).first<{
		status: string;
		shortagePolicy: "continue_available" | "cancel_entire_order";
		shortageRevision: number;
		totalAmount: number;
		cancelledAt: string | null;
	}>();
	if (!order) throw new OrderAdjustmentError(404, "ORDER_NOT_FOUND", "Order not found");
	if (!['pending', 'accepted'].includes(order.status) || order.cancelledAt) {
		throw new OrderAdjustmentError(409, "ORDER_NOT_ADJUSTABLE", "Order can no longer be adjusted");
	}

	const placeholders = request.items.map(() => "?").join(", ");
	const { results } = await db.prepare(
		`SELECT order_items.id, order_items.item_name AS name, order_items.unit_price AS unitPrice,
			order_items.quantity, COALESCE(order_item_shortages.unavailable_quantity, 0) AS unavailableQuantity
		FROM order_items
		LEFT JOIN order_item_shortages ON order_item_shortages.order_item_id = order_items.id
		WHERE order_items.order_id = ? AND order_items.id IN (${placeholders})`,
	).bind(orderId, ...request.items.map((item) => item.orderItemId)).all<{
		id: string;
		name: string;
		unitPrice: number;
		quantity: number;
		unavailableQuantity: number;
	}>();
	const rows = new Map(results.map((row) => [row.id, row]));
	let deducted = 0;
	for (const item of request.items) {
		const row = rows.get(item.orderItemId);
		if (!row) throw new OrderAdjustmentError(422, "ORDER_ITEM_NOT_FOUND", "Order item does not belong to this Order");
		if (item.quantity > row.quantity - row.unavailableQuantity) {
			throw new OrderAdjustmentError(422, "INVALID_SHORTAGE_QUANTITY", "Shortage quantity exceeds remaining quantity");
		}
		deducted += row.unitPrice * item.quantity;
	}

	const remaining = await db.prepare(
		`SELECT COALESCE(SUM(order_items.quantity - COALESCE(order_item_shortages.unavailable_quantity, 0)), 0) AS quantity
		FROM order_items
		LEFT JOIN order_item_shortages ON order_item_shortages.order_item_id = order_items.id
		WHERE order_items.order_id = ?`,
	).bind(orderId).first<{ quantity: number }>();
	const newRemainingQuantity = (remaining?.quantity ?? 0) - request.items.reduce((sum, item) => sum + item.quantity, 0);
	const shouldCancel = order.shortagePolicy === "cancel_entire_order" || newRemainingQuantity === 0;
	const newRevision = order.shortageRevision + 1;
	const timestamp = now.toISOString();
	const newTotal = shouldCancel ? 0 : order.totalAmount - deducted;
	const reason = shouldCancel
		? order.shortagePolicy === "cancel_entire_order" ? "shortage_cancelled" : "all_items_unavailable"
		: null;

	const statements: D1PreparedStatement[] = [
		db.prepare(
			`UPDATE orders SET
				total_amount = ?,
				shortage_revision = shortage_revision + 1,
				status = CASE WHEN ? = 1 THEN 'rejected' ELSE status END,
				cancelled_at = CASE WHEN ? = 1 THEN ? ELSE cancelled_at END,
				cancellation_reason = CASE WHEN ? = 1 THEN ? ELSE cancellation_reason END
			WHERE id = ? AND status IN ('pending', 'accepted') AND cancelled_at IS NULL
				AND shortage_revision = ?`,
		).bind(newTotal, shouldCancel ? 1 : 0, shouldCancel ? 1 : 0, timestamp, shouldCancel ? 1 : 0, reason, orderId, order.shortageRevision),
	];
	for (const item of request.items) {
		const row = rows.get(item.orderItemId)!;
		statements.push(db.prepare(
			`INSERT INTO order_item_shortages (order_item_id, unavailable_quantity, amount_deducted, updated_at)
			SELECT ?, ?, ?, ? FROM orders WHERE id = ? AND shortage_revision = ?
			ON CONFLICT(order_item_id) DO UPDATE SET
				unavailable_quantity = order_item_shortages.unavailable_quantity + excluded.unavailable_quantity,
				amount_deducted = order_item_shortages.amount_deducted + excluded.amount_deducted,
				updated_at = excluded.updated_at`,
		).bind(item.orderItemId, item.quantity, row.unitPrice * item.quantity, timestamp, orderId, newRevision));
	}
	statements.push(db.prepare(
		`INSERT INTO order_shortage_requests (id, order_id, request_fingerprint, created_at)
		SELECT ?, ?, ?, ? FROM orders WHERE id = ? AND shortage_revision = ?`,
	).bind(request.requestId, orderId, requestFingerprint, timestamp, orderId, newRevision));

	const batch = await db.batch(statements);
	if (batch[0]?.meta.changes !== 1) {
		throw new OrderAdjustmentError(409, "ORDER_ADJUSTMENT_CONFLICT", "Order changed during shortage processing");
	}
	if (shouldCancel) await rescheduleAfterCapacityRelease(db, now);
	const snapshot = await getOrderSnapshotById(db, orderId);
	if (!snapshot) throw new Error("Adjusted Order could not be read");
	return { order: snapshot, replayed: false };
}

export async function cancelCustomerOrder(
	db: D1Database,
	publicLookupToken: string,
	now: Date,
) {
	const row = await db.prepare(
		`SELECT id, status, order_source AS orderSource, estimated_ready_at AS estimatedReadyAt,
			cancelled_at AS cancelledAt
		FROM orders WHERE public_lookup_token = ?`,
	).bind(publicLookupToken).first<{
		id: string;
		status: string;
		orderSource: "online" | "onsite";
		estimatedReadyAt: string;
		cancelledAt: string | null;
	}>();
	if (!row) throw new OrderAdjustmentError(404, "ORDER_NOT_FOUND", "Order not found");
	if (row.cancelledAt) {
		const existing = await getOrderSnapshotByPublicLookupToken(db, publicLookupToken);
		if (!existing) throw new OrderAdjustmentError(404, "ORDER_NOT_FOUND", "Order not found");
		return { order: existing, replayed: true };
	}
	if (row.status !== "pending") {
		throw new OrderAdjustmentError(409, "CANCELLATION_NOT_ALLOWED", "Only pending Orders can be cancelled online");
	}
	if (row.orderSource === "online") {
		const latestCancellation = new Date(row.estimatedReadyAt).getTime() - 10 * 60_000;
		if (!Number.isFinite(latestCancellation) || now.getTime() > latestCancellation) {
			throw new OrderAdjustmentError(409, "CANCELLATION_DEADLINE_PASSED", "Online cancellation deadline has passed");
		}
	}
	const timestamp = now.toISOString();
	const result = await db.prepare(
		`UPDATE orders SET status = 'rejected', total_amount = 0, cancelled_at = ?,
			cancellation_reason = 'customer_cancelled', shortage_revision = shortage_revision + 1
		WHERE id = ? AND status = 'pending' AND cancelled_at IS NULL`,
	).bind(timestamp, row.id).run();
	if (result.meta.changes !== 1) {
		throw new OrderAdjustmentError(409, "ORDER_ADJUSTMENT_CONFLICT", "Order changed while cancellation was processed");
	}
	await rescheduleAfterCapacityRelease(db, now);
	const order = await getOrderSnapshotByPublicLookupToken(db, publicLookupToken);
	if (!order) throw new Error("Cancelled Order could not be read");
	return { order, replayed: false };
}
