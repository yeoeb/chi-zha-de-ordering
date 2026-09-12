import {
	parseCheckoutQuoteRequest,
	validateAndPriceCart,
	type CheckoutLineSelection,
} from "./checkout-quote";
import { getPreparationTimeEstimate } from "./preparation-time-policy";
import { getStoreSettings } from "./store-settings";

const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const CUSTOMER_NAME_MAX_LENGTH = 50;
const CUSTOMER_PHONE_MAX_LENGTH = 30;

export type CreateOrderRequest = {
	customerName: string;
	customerPhone: string;
	specialOrder: boolean;
	items: CheckoutLineSelection[];
};

export type OrderSnapshot = {
	id: string;
	publicLookupToken: string;
	orderNumber: string;
	status: "pending" | "accepted" | "completed" | "rejected";
	total: number;
	estimatedReadyAt: string;
	createdAt: string;
	customerName: string;
	customerPhone: string;
	specialOrder: boolean;
	items: Array<{
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
};

export type CreateOrderResult =
	| { order: OrderSnapshot; replayed: true }
	| { order: OrderSnapshot; replayed: false; notificationDeliveryId: string };

type OrderCreationErrorCode =
	| "INVALID_ORDER_REQUEST"
	| "INVALID_IDEMPOTENCY_KEY"
	| "IDEMPOTENCY_KEY_CONFLICT"
	| "STORE_NOT_ACCEPTING_ORDERS";

export class OrderCreationError extends Error {
	constructor(
		readonly status: 400 | 409,
		readonly code: OrderCreationErrorCode,
		message: string,
	) {
		super(message);
		this.name = "OrderCreationError";
	}
}

type StoredOrderRow = {
	orderId: string;
	publicLookupToken: string;
	orderNumber: string;
	orderStatus: OrderSnapshot["status"];
	totalAmount: number;
	estimatedReadyAt: string;
	createdAt: string;
	customerName: string;
	customerPhone: string;
	specialOrder: number;
	requestFingerprint: string;
	orderItemId: string | null;
	menuItemId: number | null;
	itemName: string | null;
	unitPrice: number | null;
	quantity: number | null;
	lineTotal: number | null;
	modifierOptionId: number | null;
	modifierGroupName: string | null;
	modifierOptionName: string | null;
	modifierPriceDelta: number | null;
};

type QueueCountRow = {
	ordersAhead: number;
	specialOrdersAhead: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>) {
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

function normalizeCustomerField(value: unknown, field: string, maxLength: number) {
	if (typeof value !== "string") {
		throw new OrderCreationError(400, "INVALID_ORDER_REQUEST", `${field} must be a string`);
	}

	const normalized = value.trim();

	if (normalized.length === 0 || normalized.length > maxLength) {
		throw new OrderCreationError(
			400,
			"INVALID_ORDER_REQUEST",
			`${field} must contain between 1 and ${maxLength} characters`,
		);
	}

	return normalized;
}

export function parseCreateOrderRequest(input: unknown): CreateOrderRequest {
	if (
		!isRecord(input) ||
		!hasOnlyKeys(input, new Set(["customerName", "customerPhone", "specialOrder", "items"]))
	) {
		throw new OrderCreationError(
			400,
			"INVALID_ORDER_REQUEST",
			"Order request contains unsupported fields",
		);
	}

	if (input.specialOrder !== undefined && typeof input.specialOrder !== "boolean") {
		throw new OrderCreationError(
			400,
			"INVALID_ORDER_REQUEST",
			"specialOrder must be a boolean",
		);
	}

	return {
		customerName: normalizeCustomerField(
			input.customerName,
			"customerName",
			CUSTOMER_NAME_MAX_LENGTH,
		),
		customerPhone: normalizeCustomerField(
			input.customerPhone,
			"customerPhone",
			CUSTOMER_PHONE_MAX_LENGTH,
		),
		specialOrder: input.specialOrder ?? false,
		items: parseCheckoutQuoteRequest({ items: input.items }),
	};
}

export function parseIdempotencyKey(value: string | undefined) {
	const normalized = value?.trim();

	if (!normalized || normalized.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
		throw new OrderCreationError(
			400,
			"INVALID_IDEMPOTENCY_KEY",
			`Idempotency-Key header is required and must not exceed ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
		);
	}

	return normalized;
}

function canonicalizeRequest(request: CreateOrderRequest) {
	const items = request.items
		.map((item) => ({
			menuItemId: item.menuItemId,
			quantity: item.quantity,
			modifierOptionIds: [...item.modifierOptionIds].sort((left, right) => left - right),
		}))
		.sort((left, right) => {
			const leftKey = JSON.stringify(left);
			const rightKey = JSON.stringify(right);
			return leftKey.localeCompare(rightKey);
		});

	return JSON.stringify({
		customerName: request.customerName,
		customerPhone: request.customerPhone,
		specialOrder: request.specialOrder,
		items,
	});
}

async function createRequestFingerprint(request: CreateOrderRequest) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonicalizeRequest(request)),
	);

	return [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

async function getStoredOrderByIdempotencyKey(db: D1Database, idempotencyKey: string) {
	const { results } = await db
		.prepare(
			`SELECT
				orders.id AS orderId,
				orders.public_lookup_token AS publicLookupToken,
				orders.order_number AS orderNumber,
				orders.status AS orderStatus,
				orders.total_amount AS totalAmount,
				orders.estimated_ready_at AS estimatedReadyAt,
				orders.created_at AS createdAt,
				orders.customer_name AS customerName,
				orders.customer_phone AS customerPhone,
				orders.special_order AS specialOrder,
				orders.request_fingerprint AS requestFingerprint,
				order_items.id AS orderItemId,
				order_items.menu_item_id AS menuItemId,
				order_items.item_name AS itemName,
				order_items.unit_price AS unitPrice,
				order_items.quantity AS quantity,
				order_items.line_total AS lineTotal,
				order_item_modifiers.modifier_option_id AS modifierOptionId,
				order_item_modifiers.modifier_group_name AS modifierGroupName,
				order_item_modifiers.modifier_option_name AS modifierOptionName,
				order_item_modifiers.price_delta AS modifierPriceDelta
			FROM orders
			LEFT JOIN order_items ON order_items.order_id = orders.id
			LEFT JOIN order_item_modifiers ON order_item_modifiers.order_item_id = order_items.id
			WHERE orders.idempotency_key = ?
			ORDER BY
				order_items.sort_order ASC,
				order_items.id ASC,
				order_item_modifiers.sort_order ASC,
				order_item_modifiers.id ASC`,
		)
		.bind(idempotencyKey)
		.all<StoredOrderRow>();

	const first = results[0];

	if (!first) {
		return null;
	}

	const order: OrderSnapshot = {
		id: first.orderId,
		publicLookupToken: first.publicLookupToken,
		orderNumber: first.orderNumber,
		status: first.orderStatus,
		total: first.totalAmount,
		estimatedReadyAt: first.estimatedReadyAt,
		createdAt: first.createdAt,
		customerName: first.customerName,
		customerPhone: first.customerPhone,
		specialOrder: Boolean(first.specialOrder),
		items: [],
	};
	const items = new Map<string, OrderSnapshot["items"][number]>();

	for (const row of results) {
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

		let item = items.get(row.orderItemId);

		if (!item) {
			item = {
				menuItemId: row.menuItemId,
				name: row.itemName,
				unitPrice: row.unitPrice,
				quantity: row.quantity,
				lineTotal: row.lineTotal,
				modifiers: [],
			};
			items.set(row.orderItemId, item);
			order.items.push(item);
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

	return { order, requestFingerprint: first.requestFingerprint };
}

async function getQueueCounts(db: D1Database) {
	const counts = await db
		.prepare(
			`SELECT
				COUNT(*) AS ordersAhead,
				COALESCE(SUM(CASE WHEN special_order = 1 THEN 1 ELSE 0 END), 0) AS specialOrdersAhead
			FROM orders
			WHERE status IN ('pending', 'accepted')`,
		)
		.first<QueueCountRow>();

	return counts ?? { ordersAhead: 0, specialOrdersAhead: 0 };
}

function createOrderNumber(now: Date) {
	const date = now.toISOString().slice(0, 10).replaceAll("-", "");
	return `CZ-${date}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

export function createPublicLookupToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function assertFingerprintMatches(existingFingerprint: string, requestFingerprint: string) {
	if (existingFingerprint !== requestFingerprint) {
		throw new OrderCreationError(
			409,
			"IDEMPOTENCY_KEY_CONFLICT",
			"Idempotency key was already used for different order content",
		);
	}
}

export async function createOrder(
	db: D1Database,
	request: CreateOrderRequest,
	idempotencyKey: string,
	now: Date,
): Promise<CreateOrderResult> {
	const requestFingerprint = await createRequestFingerprint(request);
	const existing = await getStoredOrderByIdempotencyKey(db, idempotencyKey);

	if (existing) {
		assertFingerprintMatches(existing.requestFingerprint, requestFingerprint);
		return { order: existing.order, replayed: true };
	}

	const [pricedCart, store, queueCounts] = await Promise.all([
		validateAndPriceCart(db, request.items),
		getStoreSettings(db),
		getQueueCounts(db),
	]);

	if (!store) {
		throw new Error("Store settings not found");
	}

	if (!store.is_accepting_orders) {
		throw new OrderCreationError(
			409,
			"STORE_NOT_ACCEPTING_ORDERS",
			"Store is not accepting orders",
		);
	}

	const createdAt = now.toISOString();
	const preparationTime = getPreparationTimeEstimate(
		{
			basePrepMinutes: store.base_prep_minutes,
			normalOrderMinutes: store.normal_order_minutes,
			specialExtraMinutes: store.special_extra_minutes,
			ordersAhead: queueCounts.ordersAhead,
			specialOrdersAhead: queueCounts.specialOrdersAhead,
		},
		now,
	);
	const orderId = crypto.randomUUID();
	const notificationDeliveryId = crypto.randomUUID();
	const publicLookupToken = createPublicLookupToken();
	const orderNumber = createOrderNumber(now);
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`INSERT INTO orders (
					id,
					public_lookup_token,
					order_number,
					status,
					total_amount,
					estimated_ready_at,
					created_at,
					customer_name,
					customer_phone,
					special_order,
					idempotency_key,
					request_fingerprint
				) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				orderId,
				publicLookupToken,
				orderNumber,
				pricedCart.total,
				preparationTime.estimatedReadyAt,
				createdAt,
				request.customerName,
				request.customerPhone,
				request.specialOrder ? 1 : 0,
				idempotencyKey,
				requestFingerprint,
			),
		db
			.prepare(
				`INSERT INTO web_push_notification_deliveries (
					id,
					order_id,
					event_type,
					status,
					attempt_count,
					created_at
				) VALUES (?, ?, 'new_order', 'pending', 0, ?)`,
			)
			.bind(notificationDeliveryId, orderId, createdAt),
	];
	const responseItems: OrderSnapshot["items"] = [];

	for (const [itemIndex, item] of pricedCart.items.entries()) {
		const orderItemId = crypto.randomUUID();
		const responseItem: OrderSnapshot["items"][number] = {
			menuItemId: item.menuItemId,
			name: item.name,
			unitPrice: item.unitPrice,
			quantity: item.quantity,
			lineTotal: item.lineTotal,
			modifiers: item.modifiers.map((modifier) => ({
				optionId: modifier.optionId,
				groupName: modifier.groupName,
				name: modifier.name,
				priceDelta: modifier.priceDelta,
			})),
		};

		responseItems.push(responseItem);
		statements.push(
			db
				.prepare(
					`INSERT INTO order_items (
						id,
						order_id,
						menu_item_id,
						item_name,
						unit_price,
						quantity,
						line_total,
						sort_order
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					orderItemId,
					orderId,
					item.menuItemId,
					item.name,
					item.unitPrice,
					item.quantity,
					item.lineTotal,
					itemIndex,
				),
		);

		for (const [modifierIndex, modifier] of item.modifiers.entries()) {
			statements.push(
				db
					.prepare(
						`INSERT INTO order_item_modifiers (
							id,
							order_item_id,
							modifier_option_id,
							modifier_group_name,
							modifier_option_name,
							price_delta,
							sort_order
						) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						crypto.randomUUID(),
						orderItemId,
						modifier.optionId,
						modifier.groupName,
						modifier.name,
						modifier.priceDelta,
						modifierIndex,
					),
			);
		}
	}

	try {
		await db.batch(statements);
	} catch (error) {
		const racedOrder = await getStoredOrderByIdempotencyKey(db, idempotencyKey);

		if (!racedOrder) {
			throw error;
		}

		assertFingerprintMatches(racedOrder.requestFingerprint, requestFingerprint);
		return { order: racedOrder.order, replayed: true };
	}

	return {
		order: {
			id: orderId,
			publicLookupToken,
			orderNumber,
			status: "pending" as const,
			total: pricedCart.total,
			estimatedReadyAt: preparationTime.estimatedReadyAt,
			createdAt,
			customerName: request.customerName,
			customerPhone: request.customerPhone,
			specialOrder: request.specialOrder,
			items: responseItems,
		},
		replayed: false,
		notificationDeliveryId,
	};
}
