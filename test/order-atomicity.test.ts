import { setupOrderAcceptanceTests } from "./order-acceptance-fixture";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
	createQuoteFingerprint,
	validateAndPriceCart,
} from "../src/worker/checkout-quote";
import { createOrder } from "../src/worker/order-creation";

setupOrderAcceptanceTests();

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (1, '分類', 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (1, 1, '測試餐點', '', 40, 10, 1)",
		),
	]);
	await env.DB.exec(
		"CREATE TRIGGER force_order_item_failure BEFORE INSERT ON order_items BEGIN SELECT RAISE(ABORT, 'forced order item failure'); END",
	);
});

describe("Order atomicity", () => {
	it("rolls back the Order when a required snapshot write fails", async () => {
		const items = [{ menuItemId: 1, quantity: 1, modifierOptionIds: [] }];
		const quoteFingerprint = await createQuoteFingerprint(
			await validateAndPriceCart(env.DB, items),
		);
		await expect(
			createOrder(
				env.DB,
				{
					customerName: "測試顧客",
					customerPhone: "0912345678",
					specialOrder: false,
					quoteFingerprint,
					items,
				},
				"atomic-failure-key",
				new Date("2026-09-06T10:00:00.000Z"),
			),
		).rejects.toThrow(/forced order item failure/);

		const orderCount = await env.DB
			.prepare("SELECT COUNT(*) AS count FROM orders")
			.first<{ count: number }>();
		expect(orderCount?.count).toBe(0);
		for (const table of ["order_items", "order_item_modifiers", "web_push_notification_deliveries"]) {
			expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).toEqual({ count: 0 });
		}
	});
});
