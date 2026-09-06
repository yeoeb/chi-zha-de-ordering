import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const orderItems = [{ menuItemId: 1, quantity: 1, modifierOptionIds: [10] }];

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (1, '人氣', 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (1, 1, '雞排', '', 85, 10, 1), (2, 1, '雞皮', '', 45, 20, 0)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_groups (id, menu_item_id, name, selection_type, is_required, sort_order, is_active) VALUES (1, 1, '辣度', 'single', 1, 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_options (id, modifier_group_id, name, price_delta, sort_order, is_active) VALUES (10, 1, '小辣', 0, 10, 1)",
		),
	]);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM order_item_modifiers"),
		env.DB.prepare("DELETE FROM order_items"),
		env.DB.prepare("DELETE FROM orders"),
		env.DB.prepare("UPDATE store_settings SET is_accepting_orders = 1 WHERE id = 1"),
		env.DB.prepare("UPDATE menu_items SET is_available = 1 WHERE id = 1"),
		env.DB.prepare("UPDATE menu_items SET is_available = 0 WHERE id = 2"),
	]);
});

function postQuote() {
	return exports.default.fetch("https://example.com/api/checkout/quote", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ items: orderItems }),
	});
}

function postOrder(idempotencyKey: string) {
	return exports.default.fetch("https://example.com/api/orders", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"Idempotency-Key": idempotencyKey,
		},
		body: JSON.stringify({
			customerName: "王小明",
			customerPhone: "0912345678",
			items: orderItems,
		}),
	});
}

function postAction(path: string) {
	return exports.default.fetch(`https://example.com${path}`, { method: "POST" });
}

async function getMenuItem(itemId: number) {
	const response = await exports.default.fetch("https://example.com/api/menu");
	const menu = (await response.json()) as {
		categories: Array<{ items: Array<{ id: number; name: string; isAvailable: boolean }> }>;
	};

	return {
		response,
		item: menu.categories.flatMap((category) => category.items).find((item) => item.id === itemId),
	};
}

describe("Merchant item availability", () => {
	it("marks an item sold out, keeps it visible, rejects new checkout, and restores it", async () => {
		expect((await getMenuItem(1)).item?.isAvailable).toBe(true);

		const soldOut = await postAction("/api/merchant/menu-items/1/sold-out");
		const repeatedSoldOut = await postAction("/api/merchant/menu-items/1/sold-out");
		expect(soldOut.status).toBe(200);
		expect(repeatedSoldOut.status).toBe(200);
		expect(await soldOut.json()).toMatchObject({ item: { id: 1, isAvailable: false } });
		const unavailableMenu = await getMenuItem(1);
		expect(unavailableMenu.response.status).toBe(200);
		expect(unavailableMenu.item).toMatchObject({ name: "雞排", isAvailable: false });

		const quoteWhileSoldOut = await postQuote();
		const orderWhileSoldOut = await postOrder("sold-out-order");
		expect(quoteWhileSoldOut.status).toBe(422);
		expect(await quoteWhileSoldOut.json()).toMatchObject({ error: { code: "UNAVAILABLE_ITEM" } });
		expect(orderWhileSoldOut.status).toBe(422);
		expect(await orderWhileSoldOut.json()).toMatchObject({ error: { code: "UNAVAILABLE_ITEM" } });

		const restored = await postAction("/api/merchant/menu-items/1/restore");
		const repeatedRestore = await postAction("/api/merchant/menu-items/1/restore");
		expect(restored.status).toBe(200);
		expect(repeatedRestore.status).toBe(200);
		expect(await restored.json()).toMatchObject({ item: { id: 1, isAvailable: true } });
		expect((await postQuote()).status).toBe(200);
		expect((await postOrder("restored-order")).status).toBe(201);
	});

	it("returns 404 for an unknown Menu Item", async () => {
		const response = await postAction("/api/merchant/menu-items/999/sold-out");

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: { code: "MENU_ITEM_NOT_FOUND" } });
	});

	it("does not mutate an existing Order snapshot", async () => {
		const creation = await postOrder("historical-order");
		const created = (await creation.json()) as {
			order: { publicLookupToken: string };
		};
		const createdInternal = await env.DB
			.prepare("SELECT id FROM orders WHERE public_lookup_token = ?")
			.bind(created.order.publicLookupToken)
			.first<{ id: string }>();
		await postAction("/api/merchant/menu-items/1/sold-out");

		const customerResponse = await exports.default.fetch(
			`https://example.com/api/orders/by-token/${created.order.publicLookupToken}`,
		);
		const customerOrder = await customerResponse.json();
		const acceptResponse = await postAction(
			`/api/merchant/orders/${createdInternal?.id}/accept`,
		);

		expect(customerResponse.status).toBe(200);
		expect(customerOrder).toMatchObject({
			order: {
				status: "pending",
				total: 85,
				items: [{ name: "雞排", unitPrice: 85, lineTotal: 85 }],
			},
		});
		expect(acceptResponse.status).toBe(200);
	});
});

describe("Merchant store availability", () => {
	it("pauses new checkout while existing Orders remain actionable, then resumes independently", async () => {
		const existingCreation = await postOrder("existing-before-pause");
		const existing = (await existingCreation.json()) as {
			order: { publicLookupToken: string };
		};
		const existingInternal = await env.DB
			.prepare("SELECT id FROM orders WHERE public_lookup_token = ?")
			.bind(existing.order.publicLookupToken)
			.first<{ id: string }>();
		const initialStore = await exports.default.fetch("https://example.com/api/store");
		expect(await initialStore.json()).toMatchObject({ is_accepting_orders: true });

		const pause = await postAction("/api/merchant/store/pause");
		const repeatedPause = await postAction("/api/merchant/store/pause");
		expect(pause.status).toBe(200);
		expect(repeatedPause.status).toBe(200);
		expect(await pause.json()).toMatchObject({ store: { is_accepting_orders: false } });
		const pausedStore = await exports.default.fetch("https://example.com/api/store");
		expect(await pausedStore.json()).toMatchObject({ is_accepting_orders: false });
		expect((await getMenuItem(1)).response.status).toBe(200);

		const pausedQuote = await postQuote();
		const pausedOrder = await postOrder("new-while-paused");
		expect(pausedQuote.status).toBe(409);
		expect(await pausedQuote.json()).toMatchObject({
			error: { code: "STORE_NOT_ACCEPTING_ORDERS" },
		});
		expect(pausedOrder.status).toBe(409);
		expect(await pausedOrder.json()).toMatchObject({
			error: { code: "STORE_NOT_ACCEPTING_ORDERS" },
		});

		const accepted = await postAction(`/api/merchant/orders/${existingInternal?.id}/accept`);
		const completed = await postAction(`/api/merchant/orders/${existingInternal?.id}/complete`);
		const customerOrder = await exports.default.fetch(
			`https://example.com/api/orders/by-token/${existing.order.publicLookupToken}`,
		);
		expect(accepted.status).toBe(200);
		expect(completed.status).toBe(200);
		expect(await customerOrder.json()).toMatchObject({ order: { status: "completed" } });

		await postAction("/api/merchant/menu-items/1/sold-out");
		const resume = await postAction("/api/merchant/store/resume");
		const repeatedResume = await postAction("/api/merchant/store/resume");
		expect(resume.status).toBe(200);
		expect(repeatedResume.status).toBe(200);
		expect(await resume.json()).toMatchObject({ store: { is_accepting_orders: true } });
		expect((await getMenuItem(1)).item?.isAvailable).toBe(false);
		expect((await postQuote()).status).toBe(422);

		await postAction("/api/merchant/menu-items/1/restore");
		expect((await postQuote()).status).toBe(200);
		expect((await postOrder("new-after-resume")).status).toBe(201);
	});
});

describe("Stale customer revalidation", () => {
	it("rejects Order creation when an item becomes sold out after Quote", async () => {
		expect((await postQuote()).status).toBe(200);
		await postAction("/api/merchant/menu-items/1/sold-out");

		const response = await postOrder("stale-sold-out");
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({ error: { code: "UNAVAILABLE_ITEM" } });
	});

	it("rejects Order creation when the store pauses after Quote", async () => {
		expect((await postQuote()).status).toBe(200);
		await postAction("/api/merchant/store/pause");

		const response = await postOrder("stale-paused-store");
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: { code: "STORE_NOT_ACCEPTING_ORDERS" },
		});
	});
});
