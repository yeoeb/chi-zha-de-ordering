import { setupOrderAcceptanceTests } from "./order-acceptance-fixture";
import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/worker/index";
import type { SecurityBindings } from "../src/worker/security";

const adminHeaders = {
	"content-type": "application/json",
	Origin: "https://example.com",
	"Sec-Fetch-Site": "same-origin",
};

setupOrderAcceptanceTests();

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (700, 'Admin 分類 A', 700, 1), (701, 'Admin 分類 B', 701, 1), (702, 'Admin 停用分類', 702, 0)",
		),
		env.DB.prepare(
			"INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (700, 700, 'Admin 雞排', '原描述', 80, 10, 1)",
		),
	]);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM order_item_modifiers"),
		env.DB.prepare("DELETE FROM order_items"),
		env.DB.prepare("DELETE FROM orders"),
		env.DB.prepare("UPDATE store_settings SET is_accepting_orders = 1, origin_disclosure = NULL WHERE id = 1"),
		env.DB.prepare("DELETE FROM menu_items WHERE id <> 700 AND category_id >= 700"),
		env.DB.prepare("DELETE FROM menu_categories WHERE id > 702"),
		env.DB.prepare("UPDATE menu_categories SET name = CASE id WHEN 700 THEN 'Admin 分類 A' WHEN 701 THEN 'Admin 分類 B' ELSE 'Admin 停用分類' END, sort_order = id, is_active = CASE WHEN id = 702 THEN 0 ELSE 1 END WHERE id BETWEEN 700 AND 702"),
		env.DB.prepare(
			"UPDATE menu_items SET category_id = 700, name = 'Admin 雞排', description = '原描述', price = 80, sort_order = 10, is_available = 1, image_url = NULL, is_popular = 0, is_quick_sold_out = 0, is_archived = 0 WHERE id = 700",
		),
	]);
});

function patchAdminItem(body: unknown) {
	return exports.default.fetch("https://example.com/api/admin/menu-items/700", {
		method: "PATCH",
		headers: adminHeaders,
		body: JSON.stringify(body),
	});
}

function postAdminItem(body: unknown) {
	return exports.default.fetch("https://example.com/api/admin/menu-items", {
		method: "POST",
		headers: adminHeaders,
		body: JSON.stringify(body),
	});
}

function postAdminCategory(body: unknown) {
	return exports.default.fetch("https://example.com/api/admin/categories", {
		method: "POST",
		headers: adminHeaders,
		body: JSON.stringify(body),
	});
}

function patchAdminCategory(categoryId: number, body: unknown) {
	return exports.default.fetch(`https://example.com/api/admin/categories/${categoryId}`, {
		method: "PATCH",
		headers: adminHeaders,
		body: JSON.stringify(body),
	});
}

function quoteAdminItem() {
	return exports.default.fetch("https://example.com/api/checkout/quote", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ items: [{ menuItemId: 700, quantity: 1, modifierOptionIds: [] }] }),
	});
}

async function publicMenuItemById(itemId: number) {
	const response = await exports.default.fetch("https://example.com/api/menu");
	const result = await response.json() as {
		categories: Array<{ items: Array<Record<string, unknown> & { id: number }> }>;
	};
	return result.categories.flatMap((category) => category.items).find((item) => item.id === itemId);
}

const publicMenuItem = () => publicMenuItemById(700);

describe("Admin authorization boundary", () => {
	it("fails closed without a distinct Admin identity configuration", async () => {
		const response = await app.request(
			new Request("https://example.com/api/admin/menu"),
			undefined,
			{ DB: env.DB } as Env & SecurityBindings,
			{} as ExecutionContext,
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: { code: "ADMIN_AUTH_DENIED" } });
	});

	it("does not let Merchant or Customer product routes create products", async () => {
		const body = JSON.stringify({ name: "越權商品", price: 50, categoryId: 700 });
		const merchant = await exports.default.fetch("https://example.com/api/merchant/menu-items", {
			method: "POST",
			headers: adminHeaders,
			body,
		});
		const customer = await exports.default.fetch("https://example.com/api/menu-items", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(merchant.status).toBe(404);
		expect(customer.status).toBe(404);
	});
});

describe("Admin menu API", () => {
	it("creates a product with safe defaults, generated sort order, and no modifiers", async () => {
		const response = await postAdminItem({
			name: "  新品雞塊  ",
			price: 55,
			categoryId: 700,
			description: null,
			isPopular: true,
			isQuickSoldOut: true,
		});
		expect(response.status).toBe(201);
		const result = await response.json() as { item: { id: number; sortOrder: number } };
		expect(result).toMatchObject({
			item: {
				name: "新品雞塊",
				price: 55,
				categoryId: 700,
				description: "",
				sortOrder: 20,
				isAvailable: true,
				isArchived: false,
				isPopular: true,
				isQuickSoldOut: true,
			},
		});
		expect(Number.isSafeInteger(result.item.id)).toBe(true);

		const adminMenu = await exports.default.fetch("https://example.com/api/admin/menu");
		const adminResult = await adminMenu.json() as { items: Array<{ id: number; modifierGroups: unknown[] }> };
		expect(adminResult.items.find((item) => item.id === result.item.id)).toMatchObject({ modifierGroups: [] });
		const publicItem = await publicMenuItemById(result.item.id);
		expect(publicItem).toMatchObject({ name: "新品雞塊", isAvailable: true, isPopular: true, isQuickSoldOut: true });
	});

	it("rejects unknown fields, invalid prices, and inactive or missing categories on creation", async () => {
		const unknown = await postAdminItem({ name: "新品", price: 50, categoryId: 700, isAvailable: false });
		const decimal = await postAdminItem({ name: "新品", price: 50.5, categoryId: 700 });
		const excessive = await postAdminItem({ name: "新品", price: 100_001, categoryId: 700 });
		const inactive = await postAdminItem({ name: "新品", price: 50, categoryId: 702 });
		const missing = await postAdminItem({ name: "新品", price: 50, categoryId: 999_999 });

		for (const response of [unknown, decimal, excessive, inactive, missing]) expect(response.status).toBe(400);
	});
	it("allows only validated fields and rejects unknown or invalid price fields", async () => {
		const unknown = await patchAdminItem({ price: 85, arbitrarySqlColumn: true });
		const merchantOwnedAvailability = await patchAdminItem({ isAvailable: false });
		const decimal = await patchAdminItem({ price: 85.5 });
		const text = await patchAdminItem({ price: "85" });
		const unsafeImage = await patchAdminItem({ imageUrl: "javascript:alert(1)" });

		expect(unknown.status).toBe(400);
		expect(merchantOwnedAvailability.status).toBe(400);
		expect(decimal.status).toBe(400);
		expect(text.status).toBe(400);
		expect(unsafeImage.status).toBe(400);
		expect(await env.DB.prepare("SELECT price FROM menu_items WHERE id = 700").first()).toEqual({ price: 80 });
	});

	it("persists an ordinary integer price change and authoritative quote uses it", async () => {
		const before = await quoteAdminItem();
		const update = await patchAdminItem({ price: 85 });
		const after = await quoteAdminItem();

		expect(before.status).toBe(200);
		expect(await before.json()).toMatchObject({ total: 80 });
		expect(update.status).toBe(200);
		expect(await update.json()).toMatchObject({ item: { price: 85 } });
		expect(await after.json()).toMatchObject({ total: 85, items: [{ unitPrice: 85 }] });
	});

	it("supports category reassignment and URL/presentation metadata", async () => {
		const response = await patchAdminItem({
			categoryId: 701,
			imageUrl: "https://images.example.com/chicken.jpg",
			isPopular: true,
			isQuickSoldOut: true,
			sortOrder: 25,
		});
		const publicItem = await publicMenuItem();

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			item: {
				categoryId: 701,
				imageUrl: "https://images.example.com/chicken.jpg",
				isPopular: true,
				isQuickSoldOut: true,
				sortOrder: 25,
			},
		});
		expect(publicItem).toMatchObject({
			imageUrl: "https://images.example.com/chicken.jpg",
			isPopular: true,
			isQuickSoldOut: true,
		});
	});

	it("archives and restores without deleting or rewriting historical snapshots", async () => {
		const confirmedQuote = (await (await quoteAdminItem()).json()) as {
			quoteFingerprint: string;
		};
		const creation = await exports.default.fetch("https://example.com/api/orders", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"Idempotency-Key": "admin-history-order",
			},
			body: JSON.stringify({
				customerName: "歷史顧客",
				customerPhone: "0912345678",
				quoteFingerprint: confirmedQuote.quoteFingerprint,
				items: [{ menuItemId: 700, quantity: 1, modifierOptionIds: [] }],
			}),
		});
		expect(creation.status).toBe(201);
		const created = await creation.json() as { order: { publicLookupToken: string } };
		await patchAdminItem({ name: "改名雞排", price: 95, isArchived: true });
		await patchAdminCategory(700, { name: "改名分類" });

		expect(await publicMenuItem()).toBeUndefined();
		const archivedQuote = await quoteAdminItem();
		expect(archivedQuote.status).toBe(422);
		expect(await archivedQuote.json()).toMatchObject({ error: { code: "INACTIVE_ITEM" } });
		const lookup = await exports.default.fetch(
			`https://example.com/api/orders/by-token/${created.order.publicLookupToken}`,
		);
		expect(await lookup.json()).toMatchObject({
			order: { total: 80, items: [{ name: "Admin 雞排", unitPrice: 80 }] },
		});
		const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM menu_items WHERE id = 700").first();
		expect(row).toEqual({ count: 1 });

		const restore = await patchAdminItem({ isArchived: false });
		expect(restore.status).toBe(200);
		expect(await publicMenuItem()).toMatchObject({ name: "改名雞排", price: 95 });
	});

	it("persists validated store-level origin disclosure for the public store contract", async () => {
		const update = await exports.default.fetch("https://example.com/api/admin/store-presentation", {
			method: "PATCH",
			headers: adminHeaders,
			body: JSON.stringify({ originDisclosure: "豬肉來源：待確認\n雞肉來源：待確認" }),
		});
		const publicStore = await exports.default.fetch("https://example.com/api/store");

		expect(update.status).toBe(200);
		expect(await update.json()).toEqual({ originDisclosure: "豬肉來源：待確認\n雞肉來源：待確認" });
		expect(await publicStore.json()).toMatchObject({
			originDisclosure: ["豬肉來源：待確認", "雞肉來源：待確認"],
		});

		const clear = await exports.default.fetch("https://example.com/api/admin/store-presentation", {
			method: "PATCH",
			headers: adminHeaders,
			body: JSON.stringify({ originDisclosure: "   " }),
		});
		expect(clear.status).toBe(200);
		expect(await clear.json()).toEqual({ originDisclosure: null });
	});
});

describe("Admin category API", () => {
	it("creates and lists an active category with a generated safe sort order", async () => {
		const response = await postAdminCategory({ name: "  新分類  " });
		expect(response.status).toBe(201);
		const created = await response.json() as { category: { id: number } };
		expect(created).toMatchObject({ category: { name: "新分類", sortOrder: 712, isActive: true } });

		const list = await exports.default.fetch("https://example.com/api/admin/categories");
		const result = await list.json() as { categories: Array<{ id: number }> };
		expect(result.categories.some((category) => category.id === created.category.id)).toBe(true);
	});

	it("renames and reorders a category for current Customer presentation", async () => {
		const rename = await patchAdminCategory(700, { name: "點心炸物", sortOrder: 5 });
		expect(rename.status).toBe(200);
		expect(await rename.json()).toMatchObject({ category: { name: "點心炸物", sortOrder: 5 } });

		const menuResponse = await exports.default.fetch("https://example.com/api/menu");
		const menu = await menuResponse.json() as { categories: Array<{ id: number; name: string }> };
		const adminCategories = menu.categories.filter((category) => category.id === 700 || category.id === 701);
		expect(adminCategories.map((category) => category.id)).toEqual([700, 701]);
		expect(adminCategories[0]?.name).toBe("點心炸物");
	});

	it("blocks deactivation while unarchived products remain, then hides a safely deactivated category", async () => {
		const blocked = await patchAdminCategory(700, { isActive: false });
		expect(blocked.status).toBe(409);
		expect(await blocked.json()).toMatchObject({ error: { code: "CATEGORY_IN_USE" } });

		await patchAdminItem({ isArchived: true });
		const deactivated = await patchAdminCategory(700, { isActive: false });
		expect(deactivated.status).toBe(200);
		expect(await deactivated.json()).toMatchObject({ category: { isActive: false } });
		const menuResponse = await exports.default.fetch("https://example.com/api/menu");
		const menu = await menuResponse.json() as { categories: Array<{ id: number }> };
		expect(menu.categories.some((category) => category.id === 700)).toBe(false);
	});

	it("rejects unknown category fields and invalid category values", async () => {
		const unknown = await postAdminCategory({ name: "分類", arbitrary: true });
		const invalidSort = await postAdminCategory({ name: "分類", sortOrder: 2.5 });
		const invalidActive = await postAdminCategory({ name: "分類", isActive: "yes" });
		expect(unknown.status).toBe(400);
		expect(invalidSort.status).toBe(400);
		expect(invalidActive.status).toBe(400);
	});
});
