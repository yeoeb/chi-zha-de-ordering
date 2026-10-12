import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { validateAndPriceCart } from "../src/worker/checkout-quote";

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare("INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (940, '正式菜單規則', 940, 1)"),
		env.DB.prepare("INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (940, 940, '鹹酥雞', '', 60, 10, 1), (941, 940, '魷魚', '', 60, 20, 1), (942, 940, '傳統雞排', '', 70, 30, 1), (943, 940, '起士雞排', '', 90, 40, 1)"),
		env.DB.prepare("INSERT INTO modifier_groups (id, menu_item_id, name, selection_type, is_required, sort_order, is_active) VALUES (940, 940, '份量', 'single', 1, 10, 1), (941, 941, '份量', 'single', 1, 10, 1), (942, 942, '切法', 'single', 1, 10, 1)"),
		env.DB.prepare("INSERT INTO modifier_options (id, modifier_group_id, name, price_delta, sort_order, is_active) VALUES (940, 940, '小份', 0, 10, 1), (941, 940, '大份', 40, 20, 1), (942, 941, '小份', 0, 10, 1), (943, 941, '大份', 40, 20, 1), (944, 942, '不切', 0, 10, 1), (945, 942, '切', 0, 20, 1)"),
	]);
});

describe("release menu portion and cut ownership", () => {
	it("prices both confirmed large portions at NT$100 and keeps small as the base price", async () => {
		const cart = await validateAndPriceCart(env.DB, [
			{ menuItemId: 940, quantity: 1, modifierOptionIds: [940] },
			{ menuItemId: 940, quantity: 1, modifierOptionIds: [941] },
			{ menuItemId: 941, quantity: 1, modifierOptionIds: [943] },
		]);
		expect(cart.items.map((item) => item.unitPrice)).toEqual([60, 100, 100]);
		expect(cart.total).toBe(260);
	});

	it("allows cut only on the traditional cutlet and rejects ownership injection", async () => {
		expect((await validateAndPriceCart(env.DB, [{ menuItemId: 942, quantity: 1, modifierOptionIds: [944] }])).items[0]?.modifiers[0]?.name).toBe("不切");
		await expect(validateAndPriceCart(env.DB, [{ menuItemId: 943, quantity: 1, modifierOptionIds: [945] }])).rejects.toMatchObject({ code: "INVALID_MODIFIER_OPTION" });
	});
});
