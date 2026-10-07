import { setupOrderAcceptanceTests } from "./order-acceptance-fixture";
import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const items = [
	{ menuItemId: 9, quantity: 1, modifierOptionIds: [16] },
	{ menuItemId: 10, quantity: 1, modifierOptionIds: [18] },
];

setupOrderAcceptanceTests();

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (1, '炸物', 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (9, 1, '薯條', '', 45, 90, 1), (10, 1, '甘梅地瓜', '', 55, 100, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_groups (id, menu_item_id, name, selection_type, is_required, sort_order, is_active) VALUES (5, 9, '調味', 'single', 1, 10, 1), (6, 10, '調味', 'single', 1, 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_options (id, modifier_group_id, name, price_delta, sort_order, is_active) VALUES (15, 5, '梅粉', 0, 10, 1), (16, 5, '胡椒', 0, 20, 1), (17, 5, '不加調味', 0, 30, 0), (18, 6, '梅粉', 0, 10, 1), (19, 6, '胡椒', 0, 20, 1), (20, 6, '不加調味', 0, 30, 0)",
		),
	]);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM order_item_modifiers"),
		env.DB.prepare("DELETE FROM order_items"),
		env.DB.prepare("DELETE FROM orders"),
		env.DB.prepare("UPDATE store_settings SET is_accepting_orders = 1 WHERE id = 1"),
	]);
});

describe("fries seasoning persistence", () => {
	it("carries stable seasoning option IDs from quote through Order to Merchant", async () => {
		const menuResponse = await exports.default.fetch("https://example.com/api/menu");
		const menu = (await menuResponse.json()) as {
			categories: Array<{
				items: Array<{
					id: number;
					name: string;
					modifierGroups: Array<{
						id: number;
						name: string;
						options: Array<{ id: number; name: string }>;
					}>;
				}>;
			}>;
		};
		const menuItems = menu.categories.flatMap((category) => category.items);
		expect(menuItems.find((item) => item.id === 9)).toMatchObject({
			name: "薯條",
			modifierGroups: [{
				id: 5,
				name: "調味",
				options: [
					{ id: 15, name: "梅粉" },
					{ id: 16, name: "胡椒" },
				],
			}],
		});
		expect(menuItems.find((item) => item.id === 10)).toMatchObject({
			name: "甘梅地瓜",
			modifierGroups: [{
				id: 6,
				name: "調味",
				options: [
					{ id: 18, name: "梅粉" },
					{ id: 19, name: "胡椒" },
				],
			}],
		});

		const quoteResponse = await exports.default.fetch(
			"https://example.com/api/checkout/quote",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ items }),
			},
		);
		const quote = (await quoteResponse.json()) as {
			quoteFingerprint: string;
			items: Array<{ menuItemId: number; modifiers: Array<{ optionId: number; name: string }> }>;
		};
		expect(quoteResponse.status).toBe(200);
		expect(quote.items).toEqual([
			expect.objectContaining({
				menuItemId: 9,
				modifiers: [expect.objectContaining({ optionId: 16, name: "胡椒" })],
			}),
			expect.objectContaining({
				menuItemId: 10,
				modifiers: [expect.objectContaining({ optionId: 18, name: "梅粉" })],
			}),
		]);

		const orderResponse = await exports.default.fetch("https://example.com/api/orders", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"Idempotency-Key": "fries-seasoning-flow",
			},
			body: JSON.stringify({
				customerName: "調味測試",
				customerPhone: "0912345678",
				quoteFingerprint: quote.quoteFingerprint,
				items,
			}),
		});
		expect(orderResponse.status).toBe(201);

		const merchantResponse = await exports.default.fetch(
			"https://example.com/api/merchant/orders",
		);
		const merchant = (await merchantResponse.json()) as {
			orders: Array<{
				items: Array<{
					name: string;
					modifiers: Array<{ groupName: string; name: string }>;
				}>;
			}>;
		};
		expect(merchantResponse.status).toBe(200);
		expect(merchant.orders[0]?.items).toEqual([
			expect.objectContaining({
				name: "薯條",
				modifiers: [expect.objectContaining({ groupName: "調味", name: "胡椒" })],
			}),
			expect.objectContaining({
				name: "甘梅地瓜",
				modifiers: [expect.objectContaining({ groupName: "調味", name: "梅粉" })],
			}),
		]);
	});

	it.each([
		[9, 17],
		[10, 20],
	])("rejects retired no-seasoning option %i for item %i", async (menuItemId, modifierOptionId) => {
		const response = await exports.default.fetch("https://example.com/api/checkout/quote", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				items: [{ menuItemId, quantity: 1, modifierOptionIds: [modifierOptionId] }],
			}),
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({ error: { code: "INACTIVE_MODIFIER_OPTION" } });
		const orders = await env.DB.prepare("SELECT COUNT(*) AS count FROM orders").first<{ count: number }>();
		expect(orders?.count).toBe(0);
	});
});
