import {
	createQuoteFingerprint,
	parseCheckoutQuoteRequest,
	validateAndPriceCart,
	type CheckoutLineSelection,
	type PricedCart,
} from "./checkout-quote";
import { getStoreSettings } from "./store-settings";
import { assertOrderAcceptanceWindow } from "./order-acceptance";
import { scheduledServiceCycle } from "./store-schedule";
import { getAuthorizedSchedulerActivation, SCHEDULER_ACTIVATION_GUARD_SQL } from "./scheduler-activation";
import { isValidCustomerPhone } from "../shared/customer-contact";
import {
	ONLINE_CUSTOMER_NAME,
	OPTIONAL_CUSTOMER_PHONE,
	ONSITE_CUSTOMER_NAME,
	ONSITE_CUSTOMER_PHONE,
	type OrderSource,
} from "../shared/order-source";
import {
	ACTIVE_SCHEDULE_FINGERPRINT_SQL,
	createKitchenScheduleFingerprint,
	readActiveKitchenSchedule,
	scheduleNewOrder,
} from "./order-scheduling";
import { getOrderSnapshotById } from "./merchant-orders";

const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const CUSTOMER_NOTE_MAX_LENGTH = 120;
const MAX_ATOMIC_CREATE_ATTEMPTS = 3;
const QUOTE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export type PackagingPreference = "together" | "separate_spicy";
export type ShortagePolicy = "continue_available" | "cancel_entire_order";

function hasControlCharacter(value: string, allowLineBreaks = false) {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		if (allowLineBreaks && (codePoint === 10 || codePoint === 13)) return false;
		return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
	});
}

export type CreateOrderRequest = {
	orderSource?: OrderSource;
	customerName: string;
	customerPhone: string;
	customerPhoneMode?: "hidden" | "optional";
	customerNote?: string | null;
	packagingPreference?: PackagingPreference;
	shortagePolicy?: ShortagePolicy;
	specialOrder: boolean;
	quoteFingerprint: string;
	items: CheckoutLineSelection[];
};

export type OrderSnapshot = {
	id: string;
	publicLookupToken: string;
	orderNumber: string;
	status: "pending" | "accepted" | "completed" | "rejected" | "cancelled";
	orderSource: OrderSource;
	total: number;
	estimatedReadyAt: string;
	createdAt: string;
	customerName: string;
	customerPhone: string;
	customerNote: string | null;
	packagingPreference: PackagingPreference;
	shortagePolicy: ShortagePolicy | null;
	originalTotal: number;
	shortageRevision: number;
	cancelledAt: string | null;
	cancellationReason: "customer_cancelled" | "shortage_cancelled" | "all_items_unavailable" | null;
	rejectionReason: "merchant_rejected" | "auto_rejected_unanswered" | null;
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
	shortages: Array<{
		name: string;
		quantity: number;
		amountDeducted: number;
	}>;
};

export type CreateOrderResult =
	| { order: OrderSnapshot; replayed: true }
	| { order: OrderSnapshot; replayed: false; notificationDeliveryId: string };

type OrderCreationErrorCode =
	| "INVALID_ORDER_REQUEST"
	| "INVALID_CUSTOMER_PHONE"
	| "CUSTOMER_PHONE_DISABLED"
	| "INVALID_IDEMPOTENCY_KEY"
	| "IDEMPOTENCY_KEY_CONFLICT"
	| "ORDER_STATE_CHANGED"
	| "QUOTE_CHANGED"
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
	orderSource: OrderSource;
	totalAmount: number;
	estimatedReadyAt: string;
	createdAt: string;
	customerName: string;
	customerPhone: string;
	customerNote: string | null;
	packagingPreference: PackagingPreference;
	shortagePolicy: ShortagePolicy;
	originalTotalAmount: number | null;
	shortageRevision: number;
	cancelledAt: string | null;
	cancellationReason: OrderSnapshot["cancellationReason"];
	rejectionReason: OrderSnapshot["rejectionReason"];
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>) {
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

function normalizeCustomerNote(value: unknown) {
	if (value === undefined || value === null) return null;

	if (typeof value !== "string") {
		throw new OrderCreationError(400, "INVALID_ORDER_REQUEST", "customerNote must be a string or null");
	}

	if (hasControlCharacter(value, true)) {
		throw new OrderCreationError(
			400,
			"INVALID_ORDER_REQUEST",
			"customerNote must not contain control characters",
		);
	}

	const normalized = value.trim();

	if (normalized.length === 0) return null;

	if ([...normalized].length > CUSTOMER_NOTE_MAX_LENGTH) {
		throw new OrderCreationError(
			400,
			"INVALID_ORDER_REQUEST",
			`customerNote must not exceed ${CUSTOMER_NOTE_MAX_LENGTH} characters`,
		);
	}

	return normalized;
}

function normalizeCustomerPhone(value: unknown, mode: "hidden" | "optional") {
	if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
		return OPTIONAL_CUSTOMER_PHONE;
	}
	if (mode === "hidden") {
		throw new OrderCreationError(400, "CUSTOMER_PHONE_DISABLED", "customerPhone is disabled by store settings");
	}
	if (!isValidCustomerPhone(value)) {
		throw new OrderCreationError(
			400,
			"INVALID_CUSTOMER_PHONE",
			"customerPhone must be 10 ASCII digits beginning with 09",
		);
	}

	return value;
}

function normalizePackagingPreference(value: unknown): PackagingPreference {
	if (value === undefined) return "together";
	if (value === "together" || value === "separate_spicy") return value;
	throw new OrderCreationError(
		400,
		"INVALID_ORDER_REQUEST",
		"packagingPreference must be together or separate_spicy",
	);
}

function normalizeShortagePolicy(value: unknown): ShortagePolicy {
	if (value === undefined || value === "continue_available") return "continue_available";
	if (value === "cancel_entire_order") return value;
	throw new OrderCreationError(
		400,
		"INVALID_ORDER_REQUEST",
		"shortagePolicy must be continue_available or cancel_entire_order",
	);
}

export function parseCreateOrderRequest(
	input: unknown,
	orderSource: OrderSource = "online",
	customerPhoneMode: "hidden" | "optional" = "optional",
): CreateOrderRequest {
	const allowedKeys = orderSource === "online"
		? new Set([
			"customerName",
			"customerPhone",
			"customerNote",
			"packagingPreference",
			"shortagePolicy",
			"specialOrder",
			"quoteFingerprint",
			"items",
		])
		: new Set([
			"customerNote",
			"packagingPreference",
			"specialOrder",
			"quoteFingerprint",
			"items",
		]);
	if (
		!isRecord(input) ||
		!hasOnlyKeys(input, allowedKeys)
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
	if (
		input.customerName !== undefined &&
		(typeof input.customerName !== "string" ||
			[...input.customerName.trim()].length > 50 ||
			hasControlCharacter(input.customerName))
	) {
		throw new OrderCreationError(400, "INVALID_ORDER_REQUEST", "customerName is a legacy string field");
	}

	if (
		typeof input.quoteFingerprint !== "string" ||
		!QUOTE_FINGERPRINT_PATTERN.test(input.quoteFingerprint)
	) {
		throw new OrderCreationError(
			400,
			"INVALID_ORDER_REQUEST",
			"quoteFingerprint must be a 64-character lowercase hexadecimal string",
		);
	}

	const customerPhone = orderSource === "online"
		? normalizeCustomerPhone(input.customerPhone, customerPhoneMode)
		: ONSITE_CUSTOMER_PHONE;

	return {
		orderSource,
		customerName: orderSource === "online" ? ONLINE_CUSTOMER_NAME : ONSITE_CUSTOMER_NAME,
		customerPhone,
		customerPhoneMode,
		customerNote: normalizeCustomerNote(input.customerNote),
		packagingPreference: normalizePackagingPreference(input.packagingPreference),
		...(orderSource === "online" ? { shortagePolicy: normalizeShortagePolicy(input.shortagePolicy) } : {}),
		specialOrder: input.specialOrder ?? false,
		quoteFingerprint: input.quoteFingerprint,
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
		orderSource: request.orderSource ?? "online",
		customerName: request.customerName,
		customerPhone: request.customerPhone,
		customerNote: request.customerNote ?? null,
		packagingPreference: request.packagingPreference ?? "together",
		shortagePolicy: request.shortagePolicy ?? "continue_available",
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

async function assertConfirmedQuote(pricedCart: PricedCart, quoteFingerprint: string) {
	const currentFingerprint = await createQuoteFingerprint(pricedCart);
	if (currentFingerprint !== quoteFingerprint) {
		throw new OrderCreationError(
			409,
			"QUOTE_CHANGED",
			"The authoritative quote changed and must be confirmed again",
		);
	}
}

async function getStoredOrderByIdempotencyKey(db: D1Database, idempotencyKey: string) {
	const { results } = await db
		.prepare(
			`SELECT
				orders.id AS orderId,
				orders.public_lookup_token AS publicLookupToken,
				orders.order_number AS orderNumber,
				orders.status AS orderStatus,
				orders.order_source AS orderSource,
				orders.total_amount AS totalAmount,
				orders.estimated_ready_at AS estimatedReadyAt,
				orders.created_at AS createdAt,
				orders.customer_name AS customerName,
				orders.customer_phone AS customerPhone,
				orders.customer_note AS customerNote,
				orders.packaging_preference AS packagingPreference,
				orders.shortage_policy AS shortagePolicy,
				orders.original_total_amount AS originalTotalAmount,
				orders.shortage_revision AS shortageRevision,
				orders.cancelled_at AS cancelledAt,
				orders.cancellation_reason AS cancellationReason,
				orders.rejection_reason AS rejectionReason,
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

	if (first.shortageRevision > 0 || first.cancelledAt !== null) {
		const adjustedOrder = await getOrderSnapshotById(db, first.orderId);
		if (!adjustedOrder) return null;
		return {
			order: {
				id: adjustedOrder.id,
				publicLookupToken: first.publicLookupToken,
				orderNumber: adjustedOrder.orderNumber,
				status: adjustedOrder.status,
				orderSource: adjustedOrder.orderSource,
				total: adjustedOrder.total,
				estimatedReadyAt: adjustedOrder.estimatedReadyAt,
				createdAt: adjustedOrder.createdAt,
				customerName: adjustedOrder.customerName,
				customerPhone: adjustedOrder.customerPhone,
				customerNote: adjustedOrder.customerNote,
				packagingPreference: adjustedOrder.packagingPreference,
				shortagePolicy: adjustedOrder.shortagePolicy,
				originalTotal: adjustedOrder.originalTotal,
				shortageRevision: adjustedOrder.shortageRevision,
				cancelledAt: adjustedOrder.cancelledAt,
				cancellationReason: adjustedOrder.cancellationReason,
				rejectionReason: first.rejectionReason,
				specialOrder: adjustedOrder.specialOrder,
				items: adjustedOrder.items.map(({ menuItemId, name, unitPrice, quantity, lineTotal, modifiers }) => ({
					menuItemId,
					name,
					unitPrice,
					quantity,
					lineTotal,
					modifiers,
				})),
				shortages: adjustedOrder.shortages.map(({ name, quantity, amountDeducted }) => ({
					name,
					quantity,
					amountDeducted,
				})),
			},
			requestFingerprint: first.requestFingerprint,
		};
	}

	const order: OrderSnapshot = {
		id: first.orderId,
		publicLookupToken: first.publicLookupToken,
		orderNumber: first.orderNumber,
		status: first.cancelledAt ? "cancelled" : first.orderStatus,
		orderSource: first.orderSource,
		total: first.totalAmount,
		estimatedReadyAt: first.estimatedReadyAt,
		createdAt: first.createdAt,
		customerName: first.customerName,
		customerPhone: first.customerPhone,
		customerNote: first.customerNote,
		packagingPreference: first.packagingPreference,
		shortagePolicy: first.orderSource === "onsite" ? null : first.shortagePolicy,
		originalTotal: first.originalTotalAmount ?? first.totalAmount,
		shortageRevision: first.shortageRevision,
		cancelledAt: first.cancelledAt,
		cancellationReason: first.cancellationReason,
		rejectionReason: first.rejectionReason,
		specialOrder: Boolean(first.specialOrder),
		items: [],
		shortages: [],
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

function buildCatalogCommitGuard(pricedCart: PricedCart) {
	// One bound JSON value keeps even a 50-line cart below D1's SQL-variable limit.
	// This is the server-priced snapshot, not client-supplied prices. All checks
	// still run inside the guarded INSERT and the same atomic D1 batch.
	const items = pricedCart.items.map((item) => ({
		...item,
		basePrice: item.unitPrice - item.modifiers.reduce((sum, modifier) => sum + modifier.priceDelta, 0),
	}));
	return {
		values: [JSON.stringify(items)],
		sql: `NOT EXISTS (
			SELECT 1 FROM json_each(?) AS confirmed_items
			WHERE NOT EXISTS (
				SELECT 1 FROM menu_items AS guarded_items
				JOIN menu_categories AS guarded_categories ON guarded_categories.id = guarded_items.category_id
				WHERE guarded_items.id = json_extract(confirmed_items.value, '$.menuItemId')
					AND guarded_items.name = json_extract(confirmed_items.value, '$.name')
					AND guarded_items.price = json_extract(confirmed_items.value, '$.basePrice')
					AND guarded_items.is_available = 1
					AND guarded_items.is_archived = 0
					AND guarded_categories.is_active = 1
			)
			OR EXISTS (
				SELECT 1 FROM json_each(json_extract(confirmed_items.value, '$.modifiers')) AS confirmed_modifiers
				WHERE NOT EXISTS (
					SELECT 1 FROM modifier_groups AS guarded_groups
					JOIN modifier_options AS guarded_options ON guarded_options.modifier_group_id = guarded_groups.id
					WHERE guarded_groups.id = json_extract(confirmed_modifiers.value, '$.groupId')
						AND guarded_groups.menu_item_id = json_extract(confirmed_items.value, '$.menuItemId')
						AND guarded_groups.name = json_extract(confirmed_modifiers.value, '$.groupName')
						AND guarded_groups.selection_type = 'single'
						AND guarded_groups.is_active = 1
						AND guarded_options.id = json_extract(confirmed_modifiers.value, '$.optionId')
						AND guarded_options.name = json_extract(confirmed_modifiers.value, '$.name')
						AND guarded_options.price_delta = json_extract(confirmed_modifiers.value, '$.priceDelta')
						AND guarded_options.is_active = 1
				)
			)
			OR EXISTS (
				SELECT 1 FROM modifier_groups AS guarded_required_groups
				WHERE guarded_required_groups.menu_item_id = json_extract(confirmed_items.value, '$.menuItemId')
					AND guarded_required_groups.is_active = 1
					AND (guarded_required_groups.is_required = 1 OR guarded_required_groups.name = '辣度')
					AND NOT EXISTS (
						SELECT 1 FROM modifier_options AS guarded_required_options
						JOIN json_each(json_extract(confirmed_items.value, '$.modifiers')) AS selected
							ON guarded_required_options.id = json_extract(selected.value, '$.optionId')
						WHERE guarded_required_options.modifier_group_id = guarded_required_groups.id
							AND guarded_required_options.is_active = 1
					)
			)
		)`,
	};
}

export async function createOrder(
	db: D1Database,
	request: CreateOrderRequest,
	idempotencyKey: string,
	now: Date,
	workerVersion?: string,
): Promise<CreateOrderResult> {
	const orderSource = request.orderSource ?? "online";
	const requestFingerprint = await createRequestFingerprint(request);
	const createdAt = now.toISOString();

	for (let attempt = 0; attempt < MAX_ATOMIC_CREATE_ATTEMPTS; attempt += 1) {
		const existing = await getStoredOrderByIdempotencyKey(db, idempotencyKey);

		if (existing) {
			assertFingerprintMatches(existing.requestFingerprint, requestFingerprint);
			return { order: existing.order, replayed: true };
		}

		const [pricedCart, store] = await Promise.all([
			validateAndPriceCart(db, request.items),
			getStoreSettings(db),
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

		const activation = await getAuthorizedSchedulerActivation(db, workerVersion);
		assertOrderAcceptanceWindow(store, now, activation !== null);
		const cycle = scheduledServiceCycle(store, now);
		const extendedWindow = cycle !== null && now.getTime() >= cycle.earliestClose;
		await assertConfirmedQuote(pricedCart, request.quoteFingerprint);
		const activeSchedule = await readActiveKitchenSchedule(db);
		const scheduleFingerprint = createKitchenScheduleFingerprint(activeSchedule);
		const readyAt = scheduleNewOrder(
				activeSchedule,
				{
					basePrepMinutes: store.base_prep_minutes,
					normalOrderMinutes: store.normal_order_minutes,
					specialExtraMinutes: store.special_extra_minutes,
				},
				request.specialOrder,
				now,
				orderSource,
				Boolean(store.busy_mode),
			);

		const orderId = crypto.randomUUID();
		const notificationDeliveryId = crypto.randomUUID();
		const publicLookupToken = createPublicLookupToken();
		const orderNumber = createOrderNumber(now);
		const guard = buildCatalogCommitGuard(pricedCart);
		const statements: D1PreparedStatement[] = [
			db
				.prepare(
					`INSERT INTO orders (
						id,
						public_lookup_token,
						order_number,
						status,
						order_source,
						total_amount,
						original_total_amount,
						estimated_ready_at,
						created_at,
						customer_name,
						customer_phone,
						customer_note,
						packaging_preference,
						shortage_policy,
						special_order,
						idempotency_key,
						request_fingerprint
					)
					SELECT
						?, ?, ?, 'pending', ?, ?, ?,
						?,
						?, ?, ?, ?, ?, ?, ?, ?, ?
					FROM store_settings
					WHERE store_settings.id = 1
						AND store_settings.is_accepting_orders = 1
						AND store_settings.state_version = ?
						AND store_settings.weekly_business_hours IS ?
						AND store_settings.last_order_time IS ?
						AND ${extendedWindow ? SCHEDULER_ACTIVATION_GUARD_SQL : "1"}
						AND store_settings.base_prep_minutes = ?
						AND store_settings.normal_order_minutes = ?
						AND store_settings.special_extra_minutes = ?
						AND store_settings.busy_mode = ?
						AND (? = 'onsite' OR store_settings.customer_phone_mode = ?)
						AND ${ACTIVE_SCHEDULE_FINGERPRINT_SQL} = ?
						AND NOT EXISTS (
							SELECT 1 FROM orders AS reserved
							WHERE reserved.status IN ('pending', 'accepted')
								AND reserved.cancelled_at IS NULL
								AND strftime('%Y-%m-%dT%H:%M', reserved.estimated_ready_at) = strftime('%Y-%m-%dT%H:%M', ?)
						)
						AND ${guard.sql}
					RETURNING estimated_ready_at AS estimatedReadyAt`,
				)
				.bind(
					orderId,
					publicLookupToken,
					orderNumber,
					orderSource,
					pricedCart.total,
					pricedCart.total,
					readyAt,
					createdAt,
					request.customerName,
					request.customerPhone,
					request.customerNote ?? null,
					request.packagingPreference ?? "together",
					// Legacy non-null enum is storage compatibility only for onsite.
					orderSource === "onsite" ? "continue_available" : request.shortagePolicy ?? "continue_available",
					request.specialOrder ? 1 : 0,
					idempotencyKey,
					requestFingerprint,
					store.state_version,
					store.weekly_business_hours,
					store.last_order_time,
					...(extendedWindow ? [workerVersion!, activation!.state_version] : []),
					store.base_prep_minutes,
					store.normal_order_minutes,
					store.special_extra_minutes,
					store.busy_mode,
					orderSource,
					request.customerPhoneMode ?? "optional",
					scheduleFingerprint,
					readyAt,
					...guard.values,
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
					)
					SELECT ?, ?, 'new_order', 'pending', 0, ?
					WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?)`,
				)
				.bind(notificationDeliveryId, orderId, createdAt, orderId),
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
						)
						SELECT ?, ?, ?, ?, ?, ?, ?, ?
						WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?)`,
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
						orderId,
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
							)
							SELECT ?, ?, ?, ?, ?, ?, ?
							WHERE EXISTS (SELECT 1 FROM order_items WHERE id = ?)`,
						)
						.bind(
							crypto.randomUUID(),
							orderItemId,
							modifier.optionId,
							modifier.groupName,
							modifier.name,
							modifier.priceDelta,
							modifierIndex,
							orderItemId,
						),
				);
			}
		}

		try {
			const results = await db.batch<{ estimatedReadyAt: string }>(statements);
			const inserted = results[0]?.results[0];
			if (!inserted) continue;

			return {
				order: {
					id: orderId,
					publicLookupToken,
					orderNumber,
					status: "pending" as const,
					orderSource,
					total: pricedCart.total,
					estimatedReadyAt: inserted.estimatedReadyAt,
					createdAt,
					customerName: request.customerName,
					customerPhone: request.customerPhone,
					customerNote: request.customerNote ?? null,
					packagingPreference: request.packagingPreference ?? "together",
					shortagePolicy: orderSource === "onsite" ? null : request.shortagePolicy ?? "continue_available",
					originalTotal: pricedCart.total,
					shortageRevision: 0,
					cancelledAt: null,
					cancellationReason: null,
					rejectionReason: null,
					specialOrder: request.specialOrder,
					items: responseItems,
					shortages: [],
				},
				replayed: false,
				notificationDeliveryId,
			};
		} catch (error) {
			const racedOrder = await getStoredOrderByIdempotencyKey(db, idempotencyKey);

			if (!racedOrder) {
				throw error;
			}

			assertFingerprintMatches(racedOrder.requestFingerprint, requestFingerprint);
			return { order: racedOrder.order, replayed: true };
		}
	}

	const store = await getStoreSettings(db);
	if (store && !store.is_accepting_orders) {
		throw new OrderCreationError(
			409,
			"STORE_NOT_ACCEPTING_ORDERS",
			"Store is not accepting orders",
		);
	}
	if (store) assertOrderAcceptanceWindow(store, now, (await getAuthorizedSchedulerActivation(db, workerVersion)) !== null);
	const pricedCart = await validateAndPriceCart(db, request.items);
	await assertConfirmedQuote(pricedCart, request.quoteFingerprint);
	throw new OrderCreationError(
		409,
		"ORDER_STATE_CHANGED",
		"Order inputs changed while the Order was being created; retry with the same Idempotency-Key",
	);
}
