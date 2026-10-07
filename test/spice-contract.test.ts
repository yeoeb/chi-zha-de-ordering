import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { getDefaultOptionIds, getSpiceGroup, type MenuCategory } from "../src/react-app/customer-menu";

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare("INSERT INTO menu_categories (id,name,sort_order,is_active) VALUES (1,'炸物',10,1)"),
		env.DB.prepare("INSERT INTO menu_items (id,category_id,name,description,price,sort_order,is_available) VALUES (5,1,'招牌炸蛋','',60,5,1),(9,1,'薯條','',40,9,1),(10,1,'甘梅地瓜','',50,10,1)"),
		env.DB.prepare("INSERT INTO modifier_groups (id,menu_item_id,name,selection_type,is_required,sort_order,is_active) VALUES (5,9,'調味','single',1,20,1),(6,10,'調味','single',1,20,1),(1000,9,'辣度','single',0,10,1),(2000,10,'辣度','single',0,10,1)"),
		env.DB.prepare("INSERT INTO modifier_options (id,modifier_group_id,name,price_delta,sort_order,is_active) VALUES (16,5,'胡椒',0,10,1),(18,6,'梅粉',0,10,1),(1002,1000,'小辣',0,5,1),(1001,1000,'不辣',0,10,1),(2001,2000,'不辣',0,10,1)"),
	]);
});

function post(path: string, body: unknown, key = crypto.randomUUID()) {
	return exports.default.fetch(`https://example.com${path}`, {
		method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body),
	});
}

async function businessCounts() {
	return env.DB.prepare(`SELECT (SELECT COUNT(*) FROM orders) AS orders,
		(SELECT COUNT(*) FROM order_items) AS items,
		(SELECT COUNT(*) FROM order_item_modifiers) AS modifiers,
		(SELECT COUNT(*) FROM notification_deliveries) AS notifications,
		(SELECT COUNT(*) FROM web_push_notification_deliveries) AS push`).first();
}

describe("real spice contract across menu, quote, Order and Merchant", () => {
	it("rejects missing spice even for legacy optional groups without creating business records", async () => {
		const before = await businessCounts();
		const items = [{ menuItemId: 9, quantity: 1, modifierOptionIds: [16] }];
		for (const [path, body] of [
			["/api/checkout/quote", { items }],
			["/api/orders", { items, specialOrder: false, quoteFingerprint: "a".repeat(64), packagingPreference: "together" }],
		] as const) {
			const response = await post(path, body);
			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({ error: { code: "MISSING_REQUIRED_MODIFIER" } });
		}
		expect(await businessCounts()).toEqual(before);
	});

	it("preserves API-backed non-spicy, seasoning and the egg exception all the way to Merchant", async () => {
		const menu = await (await exports.default.fetch("https://example.com/api/menu")).json() as { categories: MenuCategory[] };
		const products = menu.categories.flatMap((category) => category.items);
		const egg = products.find((item) => item.id === 5)!;
		expect(getSpiceGroup(egg)).toBeUndefined();
		expect(getSpiceGroup(products.find((item) => item.id === 9)!)?.isRequired).toBe(true);
		const items = products.map((item) => ({ menuItemId: item.id, quantity: 1, modifierOptionIds: Object.values(getDefaultOptionIds(item)) }));
		expect(items.find((item) => item.menuItemId === 9)?.modifierOptionIds.sort((a,b) => a-b)).toEqual([16,1001]);
		expect(items.find((item) => item.menuItemId === 10)?.modifierOptionIds.sort((a,b) => a-b)).toEqual([18,2001]);
		expect(items.find((item) => item.menuItemId === 5)?.modifierOptionIds).toEqual([]);
		const quoteResponse = await post("/api/checkout/quote", { items });
		expect(quoteResponse.status).toBe(200);
		const quote = await quoteResponse.json() as { total: number; quoteFingerprint: string };
		expect(quote.total).toBe(150);
		const created = await post("/api/orders", { items, specialOrder: false, quoteFingerprint: quote.quoteFingerprint, packagingPreference: "together" });
		expect(created.status).toBe(201);
		const merchant = await (await exports.default.fetch("https://example.com/api/merchant/orders")).json() as { orders: Array<{ items: Array<{ menuItemId: number; modifiers: Array<{ optionId: number; name: string }> }> }> };
		const snapshots = merchant.orders[0]!.items;
		expect(snapshots.find((item) => item.menuItemId === 9)?.modifiers).toEqual(expect.arrayContaining([
			expect.objectContaining({ optionId: 16, name: "胡椒" }), expect.objectContaining({ optionId: 1001, name: "不辣" }),
		]));
		expect(snapshots.find((item) => item.menuItemId === 10)?.modifiers).toEqual(expect.arrayContaining([
			expect.objectContaining({ optionId: 18, name: "梅粉" }), expect.objectContaining({ optionId: 2001, name: "不辣" }),
		]));
		expect(snapshots.find((item) => item.menuItemId === 5)?.modifiers).toEqual([]);
	});

	it("still rejects backend quantity zero and foreign spice IDs without adding records", async () => {
		const before = await businessCounts();
		for (const [quantity, modifierOptionIds, code] of [[0, [16,1001], "INVALID_QUANTITY"], [1, [16,2001], "INVALID_MODIFIER_OPTION"]] as const) {
			const items = [{ menuItemId: 9, quantity, modifierOptionIds }];
			const response = await post("/api/orders", { items, specialOrder: false, quoteFingerprint: "a".repeat(64), packagingPreference: "together" });
			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({ error: { code } });
		}
		expect(await businessCounts()).toEqual(before);
	});

	it("rejects an inactive spice configuration even when no option was submitted", async () => {
		const before = await businessCounts();
		await env.DB.prepare("UPDATE modifier_groups SET is_active = 0 WHERE id = 1000").run();
		try {
			for (const path of ["/api/checkout/quote", "/api/orders"]) {
				const response = await post(path, {
					items: [{ menuItemId: 9, quantity: 1, modifierOptionIds: [16] }],
					...(path === "/api/orders" ? { specialOrder: false, quoteFingerprint: "a".repeat(64), packagingPreference: "together" } : {}),
				});
				expect(response.status).toBe(422);
				expect(await response.json()).toMatchObject({ error: { code: "INACTIVE_MODIFIER_GROUP" } });
			}
			expect(await businessCounts()).toEqual(before);
		} finally {
			await env.DB.prepare("UPDATE modifier_groups SET is_active = 1 WHERE id = 1000").run();
		}
	});
});
