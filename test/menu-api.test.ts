import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

type MenuResponse = {
	categories: Array<{
		id: number;
		name: string;
		items: Array<{
			id: number;
			name: string;
			description: string;
			price: number;
			isAvailable: boolean;
			modifierGroups: Array<{
				id: number;
				name: string;
				selectionType: "single";
				isRequired: boolean;
				options: Array<{ id: number; name: string; priceDelta: number }>;
			}>;
		}>;
	}>;
};

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (10, '後段分類', 20, 1), (20, '前段分類', 10, 1), (30, '隱藏分類', 0, 0)",
		),
		env.DB.prepare(
			"INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (100, 20, '後段餐點', '', 80, 20, 1), (101, 20, '售完餐點', '', 70, 10, 0), (102, 10, '另一分類餐點', '', 40, 10, 1), (103, 30, '不應曝光餐點', '', 999, 0, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_groups (id, menu_item_id, name, selection_type, is_required, sort_order, is_active) VALUES (200, 101, '後段選項群', 'single', 1, 20, 1), (201, 101, '前段選項群', 'single', 1, 10, 1), (202, 101, '隱藏選項群', 'single', 1, 0, 0), (203, 100, '餐點專屬群', 'single', 0, 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_options (id, modifier_group_id, name, price_delta, sort_order, is_active) VALUES (300, 201, '後段選項', 5, 20, 1), (301, 201, '前段選項', 0, 10, 1), (302, 201, '隱藏選項', 0, 0, 0), (303, 200, '另一群選項', 0, 10, 1), (304, 202, '隱藏群選項', 0, 10, 1), (305, 203, '專屬選項', 0, 10, 1)",
		),
	]);
});

describe("GET /api/menu", () => {
	it("returns the active, ordered menu with nested active modifiers", async () => {
		const response = await exports.default.fetch("https://example.com/api/menu");
		const menu = (await response.json()) as MenuResponse;

		expect(response.status).toBe(200);
		expect(menu.categories.map((category) => category.id)).toEqual([20, 10]);
		expect(menu.categories[0]?.items.map((menuItem) => menuItem.id)).toEqual([101, 100]);
		expect(menu.categories.flatMap((category) => category.items).map((menuItem) => menuItem.id)).not.toContain(103);

		const unavailableItem = menu.categories[0]?.items[0];
		expect(unavailableItem?.isAvailable).toBe(false);
		expect(unavailableItem?.modifierGroups.map((group) => group.id)).toEqual([201, 200]);
		expect(unavailableItem?.modifierGroups[0]).toMatchObject({
			id: 201,
			selectionType: "single",
			isRequired: true,
			options: [
				{ id: 301, name: "前段選項", priceDelta: 0 },
				{ id: 300, name: "後段選項", priceDelta: 5 },
			],
		});
		expect(unavailableItem?.modifierGroups.flatMap((group) => group.options).map((option) => option.id)).not.toContain(302);
		expect(unavailableItem?.modifierGroups.map((group) => group.id)).not.toContain(202);
		expect(menu.categories[0]?.items[1]?.modifierGroups[0]?.id).toBe(203);
	});
});

describe("CP0 API regressions", () => {
	it("keeps health and store endpoints healthy", async () => {
		const [healthResponse, storeResponse] = await Promise.all([
			exports.default.fetch("https://example.com/api/health"),
			exports.default.fetch("https://example.com/api/store"),
		]);

		expect(await healthResponse.json()).toEqual({ status: "ok" });
		expect(storeResponse.status).toBe(200);
		expect(await storeResponse.json()).toMatchObject({
			id: 1,
			display_name: "吃炸的",
			is_accepting_orders: true,
			base_prep_minutes: 15,
			normal_order_minutes: 5,
			special_extra_minutes: 10,
		});
	});

	it("returns a Worker 404 for an unknown API route", async () => {
		const response = await exports.default.fetch("https://example.com/api/not-found");

		expect(response.status).toBe(404);
		expect(await response.text()).toBe("404 Not Found");
	});
});
