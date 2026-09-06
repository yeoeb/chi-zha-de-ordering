import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
	CheckoutQuoteError,
	validateAndPriceCart,
	type CheckoutLineSelection,
} from "../src/worker/checkout-quote";

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (1, '啟用分類', 10, 1), (2, '停用分類', 20, 0)",
		),
		env.DB.prepare(
			"INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (1, 1, '雞排', '', 85, 10, 1), (2, 1, '售完品項', '', 70, 20, 0), (3, 1, '無選項品項', '', 40, 30, 1), (4, 2, '停用分類品項', '', 50, 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_groups (id, menu_item_id, name, selection_type, is_required, sort_order, is_active) VALUES (1, 1, '辣度', 'single', 1, 10, 1), (2, 1, '加料', 'single', 0, 20, 1), (3, 1, '停用群組', 'single', 0, 30, 0), (4, 3, '其他品項群組', 'single', 0, 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_options (id, modifier_group_id, name, price_delta, sort_order, is_active) VALUES (10, 1, '不辣', 0, 10, 1), (11, 1, '小辣', 5, 20, 1), (12, 1, '停用辣度', 0, 30, 0), (20, 2, '加價選項', 10, 10, 1), (30, 3, '停用群組選項', 0, 10, 1), (40, 4, '其他品項選項', 0, 10, 1)",
		),
	]);
});

function selection(
	menuItemId: number,
	modifierOptionIds: number[],
	quantity = 1,
): CheckoutLineSelection {
	return { menuItemId, quantity, modifierOptionIds };
}

async function expectQuoteError(
	line: CheckoutLineSelection,
	code: CheckoutQuoteError["code"],
) {
	await expect(validateAndPriceCart(env.DB, [line])).rejects.toMatchObject({
		name: "CheckoutQuoteError",
		status: 422,
		code,
	});
}

describe("authoritative checkout pricing", () => {
	it("prices a base-price-only item from D1", async () => {
		const quote = await validateAndPriceCart(env.DB, [selection(3, [])]);

		expect(quote).toEqual({
			items: [
				{
					menuItemId: 3,
					name: "無選項品項",
					quantity: 1,
					unitPrice: 40,
					lineTotal: 40,
					modifiers: [],
				},
			],
			total: 40,
		});
	});

	it("adds current modifier deltas and multiplies by quantity", async () => {
		const quote = await validateAndPriceCart(env.DB, [selection(1, [11, 20], 2)]);

		expect(quote.items[0]).toMatchObject({
			name: "雞排",
			quantity: 2,
			unitPrice: 100,
			lineTotal: 200,
			modifiers: [
				{ groupName: "辣度", optionId: 11, name: "小辣", priceDelta: 5 },
				{ groupName: "加料", optionId: 20, name: "加價選項", priceDelta: 10 },
			],
		});
	});

	it("sums multiple authoritative line totals", async () => {
		const quote = await validateAndPriceCart(env.DB, [
			selection(1, [11]),
			selection(3, [], 2),
		]);

		expect(quote.items.map((item) => item.lineTotal)).toEqual([90, 80]);
		expect(quote.total).toBe(170);
	});

	it("rejects client-supplied price fields instead of trusting them", async () => {
		const response = await exports.default.fetch("https://example.com/api/checkout/quote", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				items: [{ menuItemId: 3, quantity: 1, modifierOptionIds: [], price: 1 }],
				total: 1,
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
	});

	it("returns normalized D1 values and a live zero-queue estimate", async () => {
		const before = Date.now();
		const response = await exports.default.fetch("https://example.com/api/checkout/quote", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				items: [{ menuItemId: 1, quantity: 2, modifierOptionIds: [10] }],
			}),
		});
		const after = Date.now();
		const quote = (await response.json()) as {
			items: Array<{ name: string; unitPrice: number; lineTotal: number }>;
			total: number;
			leadMinutes: number;
			estimatedReadyAt: string;
		};

		expect(response.status).toBe(200);
		expect(quote).toMatchObject({
			items: [{ name: "雞排", unitPrice: 85, lineTotal: 170 }],
			total: 170,
			leadMinutes: 15,
		});
		const estimatedReadyAt = Date.parse(quote.estimatedReadyAt);
		expect(estimatedReadyAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
		expect(estimatedReadyAt).toBeLessThanOrEqual(after + 15 * 60_000);
	});
});

describe("checkout selection validation", () => {
	it("rejects an unavailable item", () =>
		expectQuoteError(selection(2, []), "UNAVAILABLE_ITEM"));

	it("rejects an unknown item", () =>
		expectQuoteError(selection(999, []), "UNKNOWN_ITEM"));

	it("rejects an item in an inactive category", () =>
		expectQuoteError(selection(4, []), "INACTIVE_ITEM"));

	it("rejects a missing required modifier", () =>
		expectQuoteError(selection(1, []), "MISSING_REQUIRED_MODIFIER"));

	it("rejects multiple options from a single-choice group", () =>
		expectQuoteError(selection(1, [10, 11]), "MULTIPLE_MODIFIER_SELECTIONS"));

	it("rejects an option belonging to another menu item", () =>
		expectQuoteError(selection(1, [10, 40]), "INVALID_MODIFIER_OPTION"));

	it("rejects an inactive option", () =>
		expectQuoteError(selection(1, [12]), "INACTIVE_MODIFIER_OPTION"));

	it("rejects an option belonging to an inactive group", () =>
		expectQuoteError(selection(1, [10, 30]), "INACTIVE_MODIFIER_GROUP"));

	it("rejects duplicate modifier options", () =>
		expectQuoteError(selection(1, [10, 10]), "DUPLICATE_MODIFIER_OPTION"));

	it("rejects zero and negative quantities", async () => {
		await expectQuoteError(selection(3, [], 0), "INVALID_QUANTITY");
		await expectQuoteError(selection(3, [], -1), "INVALID_QUANTITY");
	});
});
