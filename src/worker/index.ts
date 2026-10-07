import { Hono, type Context } from "hono";
import { BusinessScheduleUnavailableError, restorePreviousBusinessDaySoldOut } from "./daily-sold-out";
import {
	AdminMenuError,
	createAdminCategory,
	createAdminMenuItem,
	getOriginDisclosure,
	listAdminCategories,
	listAdminMenu,
	parseAdminCategoryCreate,
	parseAdminCategoryUpdate,
	parseAdminMenuCreate,
	parseAdminMenuUpdate,
	parseOriginDisclosure,
	updateAdminMenuItem,
	updateAdminCategory,
	updateOriginDisclosure,
} from "./admin-menu";
import {
	CheckoutQuoteError,
	createQuoteFingerprint,
	parseCheckoutQuoteRequest,
	validateAndPriceCart,
} from "./checkout-quote";
import { getCustomerOrder, toCustomerOrder } from "./customer-orders";
import { getPreparationTimeEstimate } from "./preparation-time-policy";
import {
	createOrder,
	OrderCreationError,
	parseCreateOrderRequest,
	parseIdempotencyKey,
} from "./order-creation";
import {
	listActiveMerchantOrders,
	listMerchantOrderHistoryForBusinessDate,
	MerchantOrderError,
	transitionMerchantOrder,
} from "./merchant-orders";
import {
	getStoreBusinessDate,
	isStoreBusinessDateInHistoryWindow,
} from "../shared/business-date";
import {
	AvailabilityControlError,
	setMenuItemAvailability,
} from "./merchant-availability";
import { getStoreSettings } from "./store-settings";
import { readBoundedJson, RequestBodyError } from "./request-body";
import {
	deliverNewOrderNotification,
	listMerchantNotificationDeliveries,
	NotificationDeliveryError,
	retryNotificationDelivery,
} from "./notifications";
import {
	authenticateAdminRequest,
	authenticateMerchantRequest,
	isMerchantMutationRequestAllowed,
	isRateLimitAllowed,
	type SecurityBindings,
} from "./security";
import {
	getStoreOperationResult,
	parseStoreOperationRequest,
	performStoreOperation,
	StoreOperationError,
	type StoreAction,
	type StoreOperationBindings,
} from "./store-operations";
import {
	createNotificationProvider,
	getVapidPublicKey,
	parsePushSubscription,
	parsePushUnsubscribeRequest,
	PushSubscriptionRequestError,
	removeMerchantPushSubscription,
	saveMerchantPushSubscription,
	type WebPushBindings,
} from "./web-push";
import type { OrderSource } from "../shared/order-source";
import {
	cancelCustomerOrder,
	markOrderShortage,
	OrderAdjustmentError,
	parseShortageRequest,
} from "./order-adjustments";
import {
	OperationalAutomationError,
	parseBusyModeRequest,
	performBusyModeOperation,
	processDueAutoRejections,
} from "./operational-automation";
import {
	AdminStoreError,
	decodeWeeklyBusinessHours,
	getAdminStoreConfiguration,
	getTodayBusinessHours,
	parseAdminStoreConfiguration,
	updateAdminStoreConfiguration,
} from "./admin-store";
import { getMerchantRevenueSummary } from "./merchant-revenue";
import { requiresModifierSelection } from "../shared/spice";

type AppEnvironment = {
	Bindings: Env & SecurityBindings & WebPushBindings & StoreOperationBindings;
	Variables: { adminActorSubject: string; merchantActorSubject: string };
};

const app = new Hono<AppEnvironment>();

type MenuRow = {
	categoryId: number;
	categoryName: string;
	itemId: number | null;
	itemName: string | null;
	itemDescription: string | null;
	itemPrice: number | null;
	itemIsAvailable: number | null;
	itemImageUrl: string | null;
	itemIsPopular: number | null;
	itemIsQuickSoldOut: number | null;
	modifierGroupId: number | null;
	modifierGroupName: string | null;
	modifierGroupSelectionType: "single" | null;
	modifierGroupIsRequired: number | null;
	modifierOptionId: number | null;
	modifierOptionName: string | null;
	modifierOptionPriceDelta: number | null;
};

type MenuModifierGroup = {
	id: number;
	name: string;
	selectionType: "single";
	isRequired: boolean;
	options: Array<{
		id: number;
		name: string;
		priceDelta: number;
	}>;
};

type MenuItem = {
	id: number;
	name: string;
	description: string;
	price: number;
	isAvailable: boolean;
	imageUrl: string | null;
	isPopular: boolean;
	isQuickSoldOut: boolean;
	modifierGroups: MenuModifierGroup[];
};

type MenuCategory = {
	id: number;
	name: string;
	items: MenuItem[];
};

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.get("/api/store", async (c) => {
	const store = await getStoreSettings(c.env.DB);

	if (!store) {
		return c.json({ error: "Store settings not found" }, 404);
	}

	const weeklyBusinessHours = decodeWeeklyBusinessHours(store.weekly_business_hours);
	const todayHours = getTodayBusinessHours(weeklyBusinessHours);
	return c.json({
		id: store.id,
		display_name: store.display_name,
		is_accepting_orders: Boolean(store.is_accepting_orders),
		base_prep_minutes: store.base_prep_minutes,
		normal_order_minutes: store.normal_order_minutes,
		special_extra_minutes: store.special_extra_minutes,
		stateVersion: store.state_version,
		originDisclosure: store.origin_disclosure
			? store.origin_disclosure.split("\n").filter(Boolean)
			: [],
		busyMode: Boolean(store.busy_mode),
		missedOrderCount: store.missed_order_count,
		autoPauseReason: store.auto_pause_reason,
		todayIsOpen: todayHours?.isOpen ?? null,
		todayOpenAt: todayHours?.isOpen ? todayHours.openAt : null,
		todayCloseAt: todayHours?.isOpen ? todayHours.closeAt : null,
		lastOrderAt: store.last_order_time,
		customerPhoneMode: store.customer_phone_mode,
		showProductImages: Boolean(store.show_product_images),
		newOrderSoundEnabled: Boolean(store.new_order_sound_enabled),
	});
});

app.get("/api/menu", async (c) => {
	const { results } = await c.env.DB.prepare(
		`SELECT
			categories.id AS categoryId,
			categories.name AS categoryName,
			items.id AS itemId,
			items.name AS itemName,
			items.description AS itemDescription,
			items.price AS itemPrice,
			items.is_available AS itemIsAvailable,
			items.image_url AS itemImageUrl,
			items.is_popular AS itemIsPopular,
			items.is_quick_sold_out AS itemIsQuickSoldOut,
			modifier_groups.id AS modifierGroupId,
			modifier_groups.name AS modifierGroupName,
			modifier_groups.selection_type AS modifierGroupSelectionType,
			modifier_groups.is_required AS modifierGroupIsRequired,
			modifier_options.id AS modifierOptionId,
			modifier_options.name AS modifierOptionName,
			modifier_options.price_delta AS modifierOptionPriceDelta
		FROM menu_categories AS categories
		LEFT JOIN menu_items AS items ON items.category_id = categories.id AND items.is_archived = 0
		LEFT JOIN modifier_groups ON
			modifier_groups.menu_item_id = items.id
			AND modifier_groups.is_active = 1
		LEFT JOIN modifier_options ON
			modifier_options.modifier_group_id = modifier_groups.id
			AND modifier_options.is_active = 1
		WHERE categories.is_active = 1
		ORDER BY
			categories.sort_order ASC,
			categories.id ASC,
			items.sort_order ASC,
			items.id ASC,
			modifier_groups.sort_order ASC,
			modifier_groups.id ASC,
			modifier_options.sort_order ASC,
			modifier_options.id ASC`,
	).all<MenuRow>();

	const categories: MenuCategory[] = [];

	for (const row of results) {
		let category = categories[categories.length - 1];

		if (!category || category.id !== row.categoryId) {
			category = {
				id: row.categoryId,
				name: row.categoryName,
				items: [],
			};
			categories.push(category);
		}

		if (
			row.itemId !== null &&
			row.itemName !== null &&
			row.itemDescription !== null &&
			row.itemPrice !== null &&
			row.itemIsAvailable !== null &&
			row.itemIsPopular !== null &&
			row.itemIsQuickSoldOut !== null
		) {
			let item = category.items[category.items.length - 1];

			if (!item || item.id !== row.itemId) {
				item = {
					id: row.itemId,
					name: row.itemName,
					description: row.itemDescription,
					price: row.itemPrice,
					isAvailable: Boolean(row.itemIsAvailable),
					imageUrl: row.itemImageUrl,
					isPopular: Boolean(row.itemIsPopular),
					isQuickSoldOut: Boolean(row.itemIsQuickSoldOut),
					modifierGroups: [],
				};
				category.items.push(item);
			}

			if (
				row.modifierGroupId !== null &&
				row.modifierGroupName !== null &&
				row.modifierGroupSelectionType !== null &&
				row.modifierGroupIsRequired !== null
			) {
				let modifierGroup = item.modifierGroups[item.modifierGroups.length - 1];

				if (!modifierGroup || modifierGroup.id !== row.modifierGroupId) {
					modifierGroup = {
						id: row.modifierGroupId,
						name: row.modifierGroupName,
						selectionType: row.modifierGroupSelectionType,
						isRequired: requiresModifierSelection({ name: row.modifierGroupName, isRequired: Boolean(row.modifierGroupIsRequired) }),
						options: [],
					};
					item.modifierGroups.push(modifierGroup);
				}

				if (
					row.modifierOptionId !== null &&
					row.modifierOptionName !== null &&
					row.modifierOptionPriceDelta !== null
				) {
					modifierGroup.options.push({
						id: row.modifierOptionId,
						name: row.modifierOptionName,
						priceDelta: row.modifierOptionPriceDelta,
					});
				}
			}
		}
	}

	return c.json({ categories });
});

app.post("/api/checkout/quote", async (c) => {
	const clientAddress = c.req.header("CF-Connecting-IP");

	if (
		c.env.PUBLIC_WRITE_RATE_LIMIT_DEV_BYPASS !== "true" &&
		c.env.ORDER_RATE_LIMITER
	) {
		const allowed = await isRateLimitAllowed(
			c.env.ORDER_RATE_LIMITER,
			`checkout-quote:${clientAddress ?? "unknown"}`,
		);

		if (!allowed) {
			c.header("Retry-After", "60");
			return c.json(
				{ error: { code: "RATE_LIMITED", message: "Too many Checkout Quote requests" } },
				429,
			);
		}
	}

	let requestBody: unknown;

	try {
		requestBody = await readBoundedJson(c.req.raw);
	} catch (error) {
		if (error instanceof RequestBodyError && error.status === 413) {
			return c.json({ error: { code: error.code, message: error.message } }, 413);
		}

		return c.json(
			{
				error: {
					code: "INVALID_REQUEST",
					message:
						error instanceof RequestBodyError
							? error.message
							: "Request body must be valid JSON",
				},
			},
			400,
		);
	}

	try {
		const selections = parseCheckoutQuoteRequest(requestBody);
		const store = await getStoreSettings(c.env.DB);

		if (!store) {
			return c.json(
				{ error: { code: "STORE_SETTINGS_NOT_FOUND", message: "Store settings not found" } },
				500,
			);
		}

		if (!store.is_accepting_orders) {
			return c.json(
				{
					error: {
						code: "STORE_NOT_ACCEPTING_ORDERS",
						message: "Store is not accepting orders",
					},
				},
				409,
			);
		}

		const now = new Date();
		const [pricedCart, queueCounts] = await Promise.all([
			validateAndPriceCart(c.env.DB, selections),
			c.env.DB
				.prepare(
					`SELECT
						COUNT(*) AS ordersAhead,
						COALESCE(SUM(CASE WHEN special_order = 1 THEN 1 ELSE 0 END), 0)
							AS specialOrdersAhead
					FROM orders
					WHERE cancelled_at IS NULL AND (status = 'pending'
						OR (status = 'accepted' AND datetime(estimated_ready_at) > datetime(?)))`,
				)
				.bind(now.toISOString())
				.first<{ ordersAhead: number; specialOrdersAhead: number }>(),
		]);

		const preparationTime = getPreparationTimeEstimate(
			{
				basePrepMinutes: store.base_prep_minutes,
				normalOrderMinutes: store.normal_order_minutes,
				specialExtraMinutes: store.special_extra_minutes,
				ordersAhead: queueCounts?.ordersAhead ?? 0,
				specialOrdersAhead: queueCounts?.specialOrdersAhead ?? 0,
				minimumLeadMinutes: store.busy_mode ? 30 : 15,
			},
			now,
		);
		const quoteFingerprint = await createQuoteFingerprint(pricedCart);

		return c.json({ ...pricedCart, ...preparationTime, quoteFingerprint });
	} catch (error) {
		if (error instanceof CheckoutQuoteError) {
			return c.json(
				{
					error: {
						code: error.code,
						message: error.message,
						...(error.lineIssues.length > 0 ? { lineIssues: error.lineIssues } : {}),
					},
				},
				error.status,
			);
		}

		throw error;
	}
});

async function handleCreateOrder(c: Context<AppEnvironment>, orderSource: OrderSource) {
	const clientAddress = c.req.header("CF-Connecting-IP");

	if (
		c.env.PUBLIC_WRITE_RATE_LIMIT_DEV_BYPASS !== "true" &&
		c.env.ORDER_RATE_LIMITER
	) {
		const allowed = await isRateLimitAllowed(
			c.env.ORDER_RATE_LIMITER,
			`create-order:${clientAddress ?? "unknown"}`,
		);

		if (!allowed) {
			c.header("Retry-After", "60");
			return c.json(
				{ error: { code: "RATE_LIMITED", message: "Too many Order requests" } },
				429,
			);
		}
	}

	let requestBody: unknown;

	try {
		requestBody = await readBoundedJson(c.req.raw);
	} catch (error) {
		if (error instanceof RequestBodyError && error.status === 413) {
			return c.json({ error: { code: error.code, message: error.message } }, 413);
		}

		return c.json(
			{
				error: {
					code: "INVALID_ORDER_REQUEST",
					message:
						error instanceof RequestBodyError
							? error.message
							: "Request body must be valid JSON",
				},
			},
			400,
		);
	}

	try {
		const idempotencyKey = parseIdempotencyKey(c.req.header("Idempotency-Key"));
		const store = await getStoreSettings(c.env.DB);
		if (!store) {
			return c.json({ error: { code: "STORE_SETTINGS_NOT_FOUND", message: "Store settings not found" } }, 500);
		}
		const request = parseCreateOrderRequest(requestBody, orderSource, store.customer_phone_mode);
		const result = await createOrder(c.env.DB, request, idempotencyKey, new Date());

		if (!result.replayed) {
			c.executionCtx.waitUntil(
				deliverNewOrderNotification(
					c.env.DB,
					result.notificationDeliveryId,
					result.order,
					createNotificationProvider(c.env, c.env.DB),
				),
			);
		}

		return c.json(
			{ order: toCustomerOrder(result.order, result.order.publicLookupToken) },
			result.replayed ? 200 : 201,
		);
	} catch (error) {
		if (error instanceof CheckoutQuoteError || error instanceof OrderCreationError) {
			return c.json(
				{
					error: {
						code: error.code,
						message: error.message,
						...(error instanceof CheckoutQuoteError && error.lineIssues.length > 0
							? { lineIssues: error.lineIssues }
							: {}),
					},
				},
				error.status,
			);
		}

		throw error;
	}
}

app.post("/api/orders", (c) => handleCreateOrder(c, "online"));
app.post("/api/onsite/orders", (c) => handleCreateOrder(c, "onsite"));

app.get("/api/orders/by-token/:token", async (c) => {
	c.header("Cache-Control", "no-store");
	const token = c.req.param("token");

	if (!/^[a-f0-9]{64}$/.test(token)) {
		return c.json(
			{ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } },
			404,
		);
	}

	const order = await getCustomerOrder(c.env.DB, token);

	if (!order) {
		return c.json(
			{ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } },
			404,
		);
	}

	return c.json({ order });
});

app.post("/api/orders/by-token/:token/cancel", async (c) => {
	const token = c.req.param("token");
	if (!/^[a-f0-9]{64}$/.test(token)) {
		return c.json({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } }, 404);
	}
	let origin: URL;
	try {
		origin = new URL(c.req.header("Origin") ?? "invalid:");
	} catch {
		return c.json({ error: { code: "ORIGIN_DENIED", message: "Customer mutation is not authorized" } }, 403);
	}
	if (origin.origin !== new URL(c.req.url).origin || c.req.header("Sec-Fetch-Site") !== "same-origin") {
		return c.json({ error: { code: "ORIGIN_DENIED", message: "Customer mutation is not authorized" } }, 403);
	}
	try {
		const body = await readBoundedJson(c.req.raw);
		if (
			typeof body !== "object" || body === null || Array.isArray(body) ||
			Object.keys(body).length !== 1 || !("confirm" in body) || body.confirm !== true
		) {
			return c.json({ error: { code: "INVALID_CANCELLATION_REQUEST", message: "Cancellation confirmation is required" } }, 400);
		}
		const result = await cancelCustomerOrder(c.env.DB, token, new Date());
		return c.json({ order: toCustomerOrder(result.order, token), replayed: result.replayed });
	} catch (error) {
		if (error instanceof RequestBodyError || error instanceof OrderAdjustmentError) {
			const status = error instanceof OrderAdjustmentError ? error.status : 400;
			const code = error instanceof OrderAdjustmentError ? error.code : "INVALID_CANCELLATION_REQUEST";
			return c.json({ error: { code, message: error.message } }, status);
		}
		throw error;
	}
});

app.use("/api/admin/*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	const identity = await authenticateAdminRequest({
		devBypass: c.env.ADMIN_DEV_BYPASS,
		devActorSubject: c.env.ADMIN_DEV_ACTOR_SUBJECT,
		expectedHostname: c.env.ADMIN_HOSTNAME,
		requestUrl: c.req.url,
		accessAudience: c.env.ADMIN_ACCESS_AUD,
		accessTeamDomain: c.env.ADMIN_ACCESS_TEAM_DOMAIN,
		accessToken: c.req.header("Cf-Access-Jwt-Assertion"),
	});

	if (!identity) {
		return c.json(
			{ error: { code: "ADMIN_AUTH_DENIED", message: "Admin access is not authorized" } },
			403,
		);
	}
	c.set("adminActorSubject", identity.subject);

	if (
		!isMerchantMutationRequestAllowed({
			method: c.req.method,
			devBypass: c.env.ADMIN_DEV_BYPASS,
			expectedHostname: c.env.ADMIN_HOSTNAME,
			requestUrl: c.req.url,
			origin: c.req.header("Origin"),
			secFetchSite: c.req.header("Sec-Fetch-Site"),
		})
	) {
		return c.json(
			{ error: { code: "ADMIN_ORIGIN_DENIED", message: "Admin mutation is not authorized" } },
			403,
		);
	}

	await next();
});

app.get("/api/admin/menu", async (c) => c.json(await listAdminMenu(c.env.DB)));

app.post("/api/admin/menu-items", async (c) => {
	try {
		const body = await readBoundedJson(c.req.raw);
		const item = await createAdminMenuItem(c.env.DB, parseAdminMenuCreate(body));
		return c.json({ item }, 201);
	} catch (error) {
		if (error instanceof RequestBodyError || error instanceof AdminMenuError) {
			const status = error instanceof AdminMenuError ? error.status : 400;
			const code = error instanceof AdminMenuError ? error.code : "INVALID_ADMIN_UPDATE";
			return c.json({ error: { code, message: error.message } }, status);
		}
		throw error;
	}
});

app.patch("/api/admin/menu-items/:id", async (c) => {
	try {
		const body = await readBoundedJson(c.req.raw);
		const request = parseAdminMenuUpdate(body);
		const item = await updateAdminMenuItem(c.env.DB, Number(c.req.param("id")), request);
		return c.json({ item });
	} catch (error) {
		if (error instanceof RequestBodyError || error instanceof AdminMenuError) {
			const status = error instanceof AdminMenuError ? error.status : 400;
			const code = error instanceof AdminMenuError ? error.code : "INVALID_ADMIN_UPDATE";
			return c.json({ error: { code, message: error.message } }, status);
		}
		throw error;
	}
});

app.get("/api/admin/categories", async (c) => c.json({ categories: await listAdminCategories(c.env.DB) }));

app.post("/api/admin/categories", async (c) => {
	try {
		const body = await readBoundedJson(c.req.raw);
		const category = await createAdminCategory(c.env.DB, parseAdminCategoryCreate(body));
		return c.json({ category }, 201);
	} catch (error) {
		if (error instanceof RequestBodyError || error instanceof AdminMenuError) {
			const status = error instanceof AdminMenuError ? error.status : 400;
			const code = error instanceof AdminMenuError ? error.code : "INVALID_ADMIN_UPDATE";
			return c.json({ error: { code, message: error.message } }, status);
		}
		throw error;
	}
});

app.patch("/api/admin/categories/:id", async (c) => {
	try {
		const body = await readBoundedJson(c.req.raw);
		const category = await updateAdminCategory(
			c.env.DB,
			Number(c.req.param("id")),
			parseAdminCategoryUpdate(body),
		);
		return c.json({ category });
	} catch (error) {
		if (error instanceof RequestBodyError || error instanceof AdminMenuError) {
			const status = error instanceof AdminMenuError ? error.status : 400;
			const code = error instanceof AdminMenuError ? error.code : "INVALID_ADMIN_UPDATE";
			return c.json({ error: { code, message: error.message } }, status);
		}
		throw error;
	}
});

app.get("/api/admin/store-presentation", async (c) => c.json(await getOriginDisclosure(c.env.DB)));

app.patch("/api/admin/store-presentation", async (c) => {
	try {
		const body = await readBoundedJson(c.req.raw);
		return c.json(await updateOriginDisclosure(c.env.DB, parseOriginDisclosure(body)));
	} catch (error) {
		if (error instanceof RequestBodyError || error instanceof AdminMenuError) {
			return c.json(
				{ error: { code: "INVALID_ADMIN_UPDATE", message: error.message } },
				400,
			);
		}
		throw error;
	}
});

app.get("/api/admin/store", async (c) => {
	try {
		return c.json(await getAdminStoreConfiguration(c.env.DB));
	} catch (error) {
		if (error instanceof AdminStoreError) {
			return c.json({ error: { code: "INVALID_ADMIN_STORE", message: error.message } }, 400);
		}
		throw error;
	}
});

app.patch("/api/admin/store", async (c) => {
	try {
		const body = await readBoundedJson(c.req.raw);
		const settings = parseAdminStoreConfiguration(body);
		return c.json(await updateAdminStoreConfiguration(c.env.DB, settings));
	} catch (error) {
		if (error instanceof RequestBodyError || error instanceof AdminStoreError) {
			return c.json({ error: { code: "INVALID_ADMIN_STORE", message: error.message } }, 400);
		}
		throw error;
	}
});

app.use("/api/merchant/*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	const identity = await authenticateMerchantRequest({
		devBypass: c.env.MERCHANT_DEV_BYPASS,
		devActorSubject: c.env.MERCHANT_DEV_ACTOR_SUBJECT,
		expectedHostname: c.env.MERCHANT_HOSTNAME,
		requestUrl: c.req.url,
		accessAudience: c.env.CF_ACCESS_AUD,
		accessTeamDomain: c.env.CF_ACCESS_TEAM_DOMAIN,
		accessToken: c.req.header("Cf-Access-Jwt-Assertion"),
	});

	if (!identity) {
		return c.json(
			{
				error: {
					code: "AUTH_DENIED",
					message: "Merchant access is not authorized",
				},
			},
			403,
		);
	}
	c.set("merchantActorSubject", identity.subject);

	if (
		!isMerchantMutationRequestAllowed({
			method: c.req.method,
			devBypass: c.env.MERCHANT_DEV_BYPASS,
			expectedHostname: c.env.MERCHANT_HOSTNAME,
			requestUrl: c.req.url,
			origin: c.req.header("Origin"),
			secFetchSite: c.req.header("Sec-Fetch-Site"),
		})
	) {
		return c.json(
			{ error: { code: "ORIGIN_DENIED", message: "Merchant mutation is not authorized" } },
			403,
		);
	}

	await next();
});

app.get("/api/merchant/orders", async (c) => {
	return c.json({ orders: await listActiveMerchantOrders(c.env.DB) });
});

app.get("/api/merchant/orders/history", async (c) => {
	const now = new Date();
	const businessDate = c.req.query("date") ?? getStoreBusinessDate(now);
	if (!isStoreBusinessDateInHistoryWindow(businessDate, now)) {
		return c.json({ error: { code: "INVALID_HISTORY_DATE", message: "History date must be within the last 90 business days" } }, 400);
	}
	return c.json({
		businessDate,
		history: await listMerchantOrderHistoryForBusinessDate(c.env.DB, businessDate, now),
	});
});

app.get("/api/merchant/revenue", async (c) => {
	return c.json(await getMerchantRevenueSummary(c.env.DB));
});

app.get("/api/merchant/notifications", async (c) => {
	const deliveries = await listMerchantNotificationDeliveries(c.env.DB);
	return c.json({ deliveries });
});

app.get("/api/merchant/push/public-key", (c) => {
	const publicKey = getVapidPublicKey(c.env);
	if (!publicKey) {
		return c.json(
			{ error: { code: "WEB_PUSH_NOT_CONFIGURED", message: "Web Push is not configured" } },
			503,
		);
	}

	return c.json({ publicKey });
});

app.post("/api/merchant/push/subscriptions", async (c) => {
	try {
		const body = await readBoundedJson(c.req.raw);
		const subscription = parsePushSubscription(body);
		return c.json(await saveMerchantPushSubscription(c.env.DB, subscription), 201);
	} catch (error) {
		if (error instanceof RequestBodyError && error.status === 413) {
			return c.json({ error: { code: error.code, message: error.message } }, 413);
		}
		if (error instanceof RequestBodyError || error instanceof PushSubscriptionRequestError) {
			return c.json(
				{ error: { code: "INVALID_PUSH_SUBSCRIPTION", message: error.message } },
				400,
			);
		}
		throw error;
	}
});

app.delete("/api/merchant/push/subscriptions", async (c) => {
	try {
		const body = await readBoundedJson(c.req.raw);
		const endpoint = parsePushUnsubscribeRequest(body);
		return c.json(await removeMerchantPushSubscription(c.env.DB, endpoint));
	} catch (error) {
		if (error instanceof RequestBodyError && error.status === 413) {
			return c.json({ error: { code: error.code, message: error.message } }, 413);
		}
		if (error instanceof RequestBodyError || error instanceof PushSubscriptionRequestError) {
			return c.json(
				{ error: { code: "INVALID_PUSH_SUBSCRIPTION", message: error.message } },
				400,
			);
		}
		throw error;
	}
});

app.post("/api/merchant/notifications/:id/retry", async (c) => {
	try {
		const delivery = await retryNotificationDelivery(
			c.env.DB,
			c.req.param("id"),
			createNotificationProvider(c.env, c.env.DB),
			new Date(),
		);
		return c.json({ delivery });
	} catch (error) {
		if (error instanceof NotificationDeliveryError) {
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		}

		throw error;
	}
});

app.post("/api/merchant/menu-items/:id/sold-out", async (c) => {
	try {
		const item = await setMenuItemAvailability(c.env.DB, Number(c.req.param("id")), false);
		return c.json({ item });
	} catch (error) {
		if (error instanceof AvailabilityControlError || error instanceof BusinessScheduleUnavailableError) {
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		}

		throw error;
	}
});

app.post("/api/merchant/menu-items/:id/restore", async (c) => {
	try {
		const item = await setMenuItemAvailability(c.env.DB, Number(c.req.param("id")), true);
		return c.json({ item });
	} catch (error) {
		if (error instanceof AvailabilityControlError || error instanceof BusinessScheduleUnavailableError) {
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		}

		throw error;
	}
});

async function executeStoreOperation(
	c: Context<AppEnvironment>,
	action: StoreAction,
) {
	try {
		const body = await readBoundedJson(c.req.raw);
		const request = parseStoreOperationRequest(body, action);
		const result = await performStoreOperation({
			db: c.env.DB,
			action,
			request,
			actorSubject: c.get("merchantActorSubject"),
			auditActorHashKey: c.env.AUDIT_ACTOR_HASH_KEY,
			cfRay: c.req.header("CF-Ray"),
			workerVersion: c.env.CF_VERSION_METADATA?.id,
		});
		return c.json(result, result.outcome === "STALE_STATE" ? 409 : 200);
	} catch (error) {
		if (error instanceof RequestBodyError || error instanceof StoreOperationError) {
			const status = error instanceof StoreOperationError ? error.status : 400;
			const code = error instanceof StoreOperationError ? error.code : "INVALID_REQUEST";
			return c.json({ error: { code, message: error.message } }, status);
		}
		return c.json(
			{ error: { code: "INTERNAL_ERROR", message: "Store operation failed" } },
			500,
		);
	}
}

app.get("/api/merchant/store/operations/:operationId", async (c) => {
	try {
		const result = await getStoreOperationResult(c.env.DB, c.req.param("operationId"));
		if (!result) {
			return c.json(
				{ error: { code: "OPERATION_NOT_FOUND", message: "Store operation not found" } },
				404,
			);
		}
		return c.json(result);
	} catch (error) {
		if (error instanceof StoreOperationError) {
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		}
		return c.json(
			{ error: { code: "INTERNAL_ERROR", message: "Store operation lookup failed" } },
			500,
		);
	}
});

app.post("/api/merchant/store/pause", (c) => {
	return executeStoreOperation(c, "pause");
});

app.post("/api/merchant/store/resume", (c) => {
	return executeStoreOperation(c, "resume");
});

app.post("/api/merchant/store/busy-mode", async (c) => {
	try {
		const request = parseBusyModeRequest(await readBoundedJson(c.req.raw));
		const result = await performBusyModeOperation({
			db: c.env.DB,
			request,
			actorSubject: c.get("merchantActorSubject"),
			auditActorHashKey: c.env.AUDIT_ACTOR_HASH_KEY,
		});
		return c.json(result, result.outcome === "STALE_STATE" ? 409 : 200);
	} catch (error) {
		if (error instanceof RequestBodyError || error instanceof OperationalAutomationError) {
			const status = error instanceof OperationalAutomationError ? error.status : 400;
			const code = error instanceof OperationalAutomationError ? error.code : "INVALID_REQUEST";
			return c.json({ error: { code, message: error.message } }, status);
		}
		throw error;
	}
});

app.post("/api/merchant/orders/:id/accept", async (c) => {
	try {
		const order = await transitionMerchantOrder(c.env.DB, c.req.param("id"), "accept", new Date());
		return c.json({ order });
	} catch (error) {
		if (error instanceof MerchantOrderError) {
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		}

		throw error;
	}
});

app.post("/api/merchant/orders/:id/reject", async (c) => {
	try {
		const order = await transitionMerchantOrder(c.env.DB, c.req.param("id"), "reject", new Date());
		return c.json({ order });
	} catch (error) {
		if (error instanceof MerchantOrderError) {
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		}

		throw error;
	}
});

app.post("/api/merchant/orders/:id/complete", async (c) => {
	try {
		const order = await transitionMerchantOrder(
			c.env.DB,
			c.req.param("id"),
			"complete",
			new Date(),
		);
		return c.json({ order });
	} catch (error) {
		if (error instanceof MerchantOrderError) {
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		}

		throw error;
	}
});

app.post("/api/merchant/orders/:id/shortages", async (c) => {
	try {
		const request = parseShortageRequest(await readBoundedJson(c.req.raw));
		const result = await markOrderShortage(c.env.DB, c.req.param("id"), request, new Date());
		return c.json(result);
	} catch (error) {
		if (error instanceof BusinessScheduleUnavailableError) {
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		}
		if (error instanceof RequestBodyError || error instanceof OrderAdjustmentError) {
			const status = error instanceof OrderAdjustmentError ? error.status : 400;
			const code = error instanceof OrderAdjustmentError ? error.code : "INVALID_SHORTAGE_REQUEST";
			return c.json({ error: { code, message: error.message } }, status);
		}
		throw error;
	}
});

const worker = Object.assign(app, {
	scheduled(_controller: ScheduledController, env: AppEnvironment["Bindings"], ctx: ExecutionContext) {
		ctx.waitUntil(processDueAutoRejections(env.DB));
		ctx.waitUntil(restorePreviousBusinessDaySoldOut(env.DB));
	},
});

export default worker;
