import { advancePendingOnsiteOrders } from "./order-scheduling";
import { getStoreSettings } from "./store-settings";

export type OrderStatus = "pending" | "accepted" | "completed" | "rejected" | "cancelled";

export type MerchantOrder = {
	id: string;
	orderNumber: string;
	status: OrderStatus;
	orderSource: "online" | "onsite";
	total: number;
	originalTotal: number;
	shortagePolicy: "continue_available" | "cancel_entire_order";
	shortageRevision: number;
	cancelledAt: string | null;
	cancellationReason: "customer_cancelled" | "shortage_cancelled" | "all_items_unavailable" | null;
	estimatedReadyAt: string;
	createdAt: string;
	acceptedAt: string | null;
	completedAt: string | null;
	rejectedAt: string | null;
	customerName: string;
	customerPhone: string;
	customerNote: string | null;
	packagingPreference: "together" | "separate_spicy";
	specialOrder: boolean;
	items: Array<{
		id: string;
		menuItemId: number;
		name: string;
		unitPrice: number;
		quantity: number;
		lineTotal: number;
		modifiers: Array<{
			optionId: number;
			groupName: string;
			name: string;
			priceDelta: number;
		}>;
	}>;
	shortages: Array<{
		orderItemId: string;
		name: string;
		quantity: number;
		amountDeducted: number;
	}>;
};

export type MerchantOrderAction = "accept" | "reject" | "complete";

type MerchantOrderErrorCode = "ORDER_NOT_FOUND" | "ILLEGAL_ORDER_TRANSITION";

export class MerchantOrderError extends Error {
	constructor(
		readonly status: 404 | 409,
		readonly code: MerchantOrderErrorCode,
		message: string,
	) {
		super(message);
		this.name = "MerchantOrderError";
	}
}

type MerchantOrderRow = {
	orderId: string;
	orderNumber: string;
	orderStatus: OrderStatus;
	orderSource: "online" | "onsite";
	totalAmount: number;
	originalTotalAmount: number | null;
	shortagePolicy: MerchantOrder["shortagePolicy"];
	shortageRevision: number;
	cancelledAt: string | null;
	cancellationReason: MerchantOrder["cancellationReason"];
	estimatedReadyAt: string;
	createdAt: string;
	acceptedAt: string | null;
	completedAt: string | null;
	rejectedAt: string | null;
	customerName: string;
	customerPhone: string;
	customerNote: string | null;
	packagingPreference: "together" | "separate_spicy";
	specialOrder: number;
	orderItemId: string | null;
	menuItemId: number | null;
	itemName: string | null;
	unitPrice: number | null;
	quantity: number | null;
	lineTotal: number | null;
	unavailableQuantity: number | null;
	amountDeducted: number | null;
	modifierOptionId: number | null;
	modifierGroupName: string | null;
	modifierOptionName: string | null;
	modifierPriceDelta: number | null;
};

const SNAPSHOT_SELECT = `SELECT
	orders.id AS orderId,
	orders.order_number AS orderNumber,
	orders.status AS orderStatus,
	orders.order_source AS orderSource,
	orders.total_amount AS totalAmount,
	orders.original_total_amount AS originalTotalAmount,
	orders.shortage_policy AS shortagePolicy,
	orders.shortage_revision AS shortageRevision,
	orders.cancelled_at AS cancelledAt,
	orders.cancellation_reason AS cancellationReason,
	orders.estimated_ready_at AS estimatedReadyAt,
	orders.created_at AS createdAt,
	orders.accepted_at AS acceptedAt,
	orders.completed_at AS completedAt,
	orders.rejected_at AS rejectedAt,
	orders.customer_name AS customerName,
	orders.customer_phone AS customerPhone,
	orders.customer_note AS customerNote,
	orders.packaging_preference AS packagingPreference,
	orders.special_order AS specialOrder,
	order_items.id AS orderItemId,
	order_items.menu_item_id AS menuItemId,
	order_items.item_name AS itemName,
	order_items.unit_price AS unitPrice,
	order_items.quantity AS quantity,
	order_items.line_total AS lineTotal,
	order_item_shortages.unavailable_quantity AS unavailableQuantity,
	order_item_shortages.amount_deducted AS amountDeducted,
	order_item_modifiers.modifier_option_id AS modifierOptionId,
	order_item_modifiers.modifier_group_name AS modifierGroupName,
	order_item_modifiers.modifier_option_name AS modifierOptionName,
	order_item_modifiers.price_delta AS modifierPriceDelta
FROM orders
LEFT JOIN order_items ON order_items.order_id = orders.id
LEFT JOIN order_item_shortages ON order_item_shortages.order_item_id = order_items.id
LEFT JOIN order_item_modifiers ON order_item_modifiers.order_item_id = order_items.id`;

const SNAPSHOT_ORDER = `ORDER BY
	orders.estimated_ready_at ASC,
	orders.created_at ASC,
	orders.id ASC,
	order_items.sort_order ASC,
	order_items.id ASC,
	order_item_modifiers.sort_order ASC,
	order_item_modifiers.id ASC`;

function buildMerchantOrders(rows: MerchantOrderRow[]) {
	const orders: MerchantOrder[] = [];
	const ordersById = new Map<
		string,
		{ order: MerchantOrder; items: Map<string, MerchantOrder["items"][number]> }
	>();

	for (const row of rows) {
		let entry = ordersById.get(row.orderId);

		if (!entry) {
			const order: MerchantOrder = {
				id: row.orderId,
				orderNumber: row.orderNumber,
				status: row.cancelledAt ? "cancelled" : row.orderStatus,
				orderSource: row.orderSource,
				total: row.totalAmount,
				originalTotal: row.originalTotalAmount ?? row.totalAmount,
				shortagePolicy: row.shortagePolicy,
				shortageRevision: row.shortageRevision,
				cancelledAt: row.cancelledAt,
				cancellationReason: row.cancellationReason,
				estimatedReadyAt: row.estimatedReadyAt,
				createdAt: row.createdAt,
				acceptedAt: row.acceptedAt,
				completedAt: row.completedAt,
				rejectedAt: row.rejectedAt,
				customerName: row.customerName,
				customerPhone: row.customerPhone,
				customerNote: row.customerNote,
				packagingPreference: row.packagingPreference,
				specialOrder: Boolean(row.specialOrder),
				items: [],
				shortages: [],
			};
			entry = { order, items: new Map() };
			ordersById.set(row.orderId, entry);
			orders.push(order);
		}

		if (
			row.orderItemId === null ||
			row.menuItemId === null ||
			row.itemName === null ||
			row.unitPrice === null ||
			row.quantity === null ||
			row.lineTotal === null
		) {
			continue;
		}

		let item = entry.items.get(row.orderItemId);

		if (!item) {
			const unavailableQuantity = row.unavailableQuantity ?? 0;
			const remainingQuantity = Math.max(0, row.quantity - unavailableQuantity);
			item = {
				id: row.orderItemId,
				menuItemId: row.menuItemId,
				name: row.itemName,
				unitPrice: row.unitPrice,
				quantity: remainingQuantity,
				lineTotal: row.unitPrice * remainingQuantity,
				modifiers: [],
			};
			entry.items.set(row.orderItemId, item);
			if (remainingQuantity > 0) entry.order.items.push(item);
			if (unavailableQuantity > 0) {
				entry.order.shortages.push({
					orderItemId: row.orderItemId,
					name: row.itemName,
					quantity: unavailableQuantity,
					amountDeducted: row.amountDeducted ?? row.unitPrice * unavailableQuantity,
				});
			}
		}

		if (
			row.modifierOptionId !== null &&
			row.modifierGroupName !== null &&
			row.modifierOptionName !== null &&
			row.modifierPriceDelta !== null
		) {
			item.modifiers.push({
				optionId: row.modifierOptionId,
				groupName: row.modifierGroupName,
				name: row.modifierOptionName,
				priceDelta: row.modifierPriceDelta,
			});
		}
	}

	return orders;
}

export async function listActiveMerchantOrders(db: D1Database) {
	const { results } = await db
		.prepare(`${SNAPSHOT_SELECT} WHERE orders.status IN ('pending', 'accepted') ${SNAPSHOT_ORDER}`)
		.all<MerchantOrderRow>();

	return buildMerchantOrders(results);
}

export async function listRecentMerchantOrderHistory(db: D1Database, limit = 50) {
	const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
	const { results } = await db
		.prepare(
			`${SNAPSHOT_SELECT}
			WHERE orders.id IN (
				SELECT id
				FROM orders
				WHERE status IN ('completed', 'rejected')
				ORDER BY COALESCE(completed_at, rejected_at, created_at) DESC, id DESC
				LIMIT ?
			)
			ORDER BY
				COALESCE(orders.completed_at, orders.rejected_at, orders.created_at) DESC,
				orders.id DESC,
				order_items.sort_order ASC,
				order_items.id ASC,
				order_item_modifiers.sort_order ASC,
				order_item_modifiers.id ASC`,
		)
		.bind(safeLimit)
		.all<MerchantOrderRow>();

	return buildMerchantOrders(results);
}

export async function getOrderSnapshotById(db: D1Database, orderId: string) {
	const { results } = await db
		.prepare(`${SNAPSHOT_SELECT} WHERE orders.id = ? ${SNAPSHOT_ORDER}`)
		.bind(orderId)
		.all<MerchantOrderRow>();

	return buildMerchantOrders(results)[0] ?? null;
}

export async function getOrderSnapshotByPublicLookupToken(
	db: D1Database,
	publicLookupToken: string,
) {
	const { results } = await db
		.prepare(`${SNAPSHOT_SELECT} WHERE orders.public_lookup_token = ? ${SNAPSHOT_ORDER}`)
		.bind(publicLookupToken)
		.all<MerchantOrderRow>();

	return buildMerchantOrders(results)[0] ?? null;
}

function requireValidNow(now: Date) {
	if (Number.isNaN(now.getTime())) {
		throw new RangeError("now must be a valid date");
	}
}

export async function transitionMerchantOrder(
	db: D1Database,
	orderId: string,
	action: MerchantOrderAction,
	now: Date,
) {
	requireValidNow(now);
	const timestamp = now.toISOString();
	let result: D1Result;

	switch (action) {
		case "accept":
			result = await db
				.prepare(
					`UPDATE orders
					SET status = 'accepted', accepted_at = ?
					WHERE id = ? AND status = 'pending'`,
				)
				.bind(timestamp, orderId)
				.run();
			break;
		case "reject":
			result = await db
				.prepare(
					`UPDATE orders
					SET status = 'rejected', rejected_at = ?
					WHERE id = ? AND status = 'pending'`,
				)
				.bind(timestamp, orderId)
				.run();
			break;
		case "complete":
			result = await db
				.prepare(
					`UPDATE orders
					SET status = 'completed', completed_at = ?
					WHERE id = ? AND status = 'accepted'`,
				)
				.bind(timestamp, orderId)
				.run();
			break;
	}

	if (result.meta.changes === 0) {
		const existing = await db
			.prepare("SELECT status FROM orders WHERE id = ?")
			.bind(orderId)
			.first<{ status: OrderStatus }>();

		if (!existing) {
			throw new MerchantOrderError(404, "ORDER_NOT_FOUND", "Order not found");
		}

		throw new MerchantOrderError(
			409,
			"ILLEGAL_ORDER_TRANSITION",
			`Cannot ${action} an Order with status ${existing.status}`,
		);
	}

	if (action === "complete" || action === "reject") {
		try {
			const store = await getStoreSettings(db);
			if (store) {
				await advancePendingOnsiteOrders(db, {
					basePrepMinutes: store.base_prep_minutes,
					normalOrderMinutes: store.normal_order_minutes,
					specialExtraMinutes: store.special_extra_minutes,
				}, now);
			}
		} catch {
			// The state transition is already authoritative. A stale schedule snapshot is
			// deliberately left unchanged instead of risking an unsafe deadline move.
		}
	}

	const order = await getOrderSnapshotById(db, orderId);

	if (!order) {
		throw new Error("Updated Order could not be read");
	}

	return order;
}
