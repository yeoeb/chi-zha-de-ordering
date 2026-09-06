import { Hono } from "hono";
import {
	CheckoutQuoteError,
	parseCheckoutQuoteRequest,
	validateAndPriceCart,
} from "./checkout-quote";
import { getCustomerOrder } from "./customer-orders";
import { getPreparationTimeEstimate } from "./preparation-time-policy";
import {
	createOrder,
	OrderCreationError,
	parseCreateOrderRequest,
	parseIdempotencyKey,
} from "./order-creation";
import {
	listActiveMerchantOrders,
	MerchantOrderError,
	transitionMerchantOrder,
} from "./merchant-orders";
import {
	AvailabilityControlError,
	setMenuItemAvailability,
	setStoreAcceptingOrders,
} from "./merchant-availability";
import { getStoreSettings } from "./store-settings";

const app = new Hono<{ Bindings: Env }>();

type MenuRow = {
	categoryId: number;
	categoryName: string;
	itemId: number | null;
	itemName: string | null;
	itemDescription: string | null;
	itemPrice: number | null;
	itemIsAvailable: number | null;
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

	return c.json({
		...store,
		is_accepting_orders: Boolean(store.is_accepting_orders),
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
			modifier_groups.id AS modifierGroupId,
			modifier_groups.name AS modifierGroupName,
			modifier_groups.selection_type AS modifierGroupSelectionType,
			modifier_groups.is_required AS modifierGroupIsRequired,
			modifier_options.id AS modifierOptionId,
			modifier_options.name AS modifierOptionName,
			modifier_options.price_delta AS modifierOptionPriceDelta
		FROM menu_categories AS categories
		LEFT JOIN menu_items AS items ON items.category_id = categories.id
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
			row.itemIsAvailable !== null
		) {
			let item = category.items[category.items.length - 1];

			if (!item || item.id !== row.itemId) {
				item = {
					id: row.itemId,
					name: row.itemName,
					description: row.itemDescription,
					price: row.itemPrice,
					isAvailable: Boolean(row.itemIsAvailable),
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
						isRequired: Boolean(row.modifierGroupIsRequired),
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
	let requestBody: unknown;

	try {
		requestBody = await c.req.json<unknown>();
	} catch {
		return c.json(
			{ error: { code: "INVALID_REQUEST", message: "Request body must be valid JSON" } },
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

		const pricedCart = await validateAndPriceCart(c.env.DB, selections);

		const preparationTime = getPreparationTimeEstimate(
			{
				basePrepMinutes: store.base_prep_minutes,
				normalOrderMinutes: store.normal_order_minutes,
				specialExtraMinutes: store.special_extra_minutes,
				// A Quote is a preview; only Order creation uses the live queue.
				ordersAhead: 0,
				specialOrdersAhead: 0,
			},
			new Date(),
		);

		return c.json({ ...pricedCart, ...preparationTime });
	} catch (error) {
		if (error instanceof CheckoutQuoteError) {
			return c.json(
				{ error: { code: error.code, message: error.message } },
				error.status,
			);
		}

		throw error;
	}
});

app.post("/api/orders", async (c) => {
	let requestBody: unknown;

	try {
		requestBody = await c.req.json<unknown>();
	} catch {
		return c.json(
			{ error: { code: "INVALID_ORDER_REQUEST", message: "Request body must be valid JSON" } },
			400,
		);
	}

	try {
		const idempotencyKey = parseIdempotencyKey(c.req.header("Idempotency-Key"));
		const request = parseCreateOrderRequest(requestBody);
		const result = await createOrder(c.env.DB, request, idempotencyKey, new Date());

		return c.json({ order: result.order }, result.replayed ? 200 : 201);
	} catch (error) {
		if (error instanceof CheckoutQuoteError || error instanceof OrderCreationError) {
			return c.json(
				{ error: { code: error.code, message: error.message } },
				error.status,
			);
		}

		throw error;
	}
});

app.get("/api/orders/:id", async (c) => {
	c.header("Cache-Control", "no-store");
	const order = await getCustomerOrder(c.env.DB, c.req.param("id"));

	if (!order) {
		return c.json(
			{ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } },
			404,
		);
	}

	return c.json({ order });
});

app.get("/api/merchant/orders", async (c) => {
	const orders = await listActiveMerchantOrders(c.env.DB);
	return c.json({ orders });
});

app.post("/api/merchant/menu-items/:id/sold-out", async (c) => {
	try {
		const item = await setMenuItemAvailability(c.env.DB, Number(c.req.param("id")), false);
		return c.json({ item });
	} catch (error) {
		if (error instanceof AvailabilityControlError) {
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
		if (error instanceof AvailabilityControlError) {
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		}

		throw error;
	}
});

app.post("/api/merchant/store/pause", async (c) => {
	try {
		const store = await setStoreAcceptingOrders(c.env.DB, false);
		return c.json({ store });
	} catch (error) {
		if (error instanceof AvailabilityControlError) {
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
		}

		throw error;
	}
});

app.post("/api/merchant/store/resume", async (c) => {
	try {
		const store = await setStoreAcceptingOrders(c.env.DB, true);
		return c.json({ store });
	} catch (error) {
		if (error instanceof AvailabilityControlError) {
			return c.json({ error: { code: error.code, message: error.message } }, error.status);
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

export default app;
