import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { getMerchantRevenueSummary } from "../src/worker/merchant-revenue";

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare("INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (801, '營收分類', 1, 1)"),
		env.DB.prepare("INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (801, 801, '雞排快照', '', 90, 1, 0), (802, 801, '薯條快照', '', 40, 2, 1)"),
	]);
	const orders = [
		["revenue-pending", "pending", 180, "2026-10-05T10:30:00.000Z", null, null],
		["revenue-accepted", "accepted", 40, "2026-10-05T10:45:00.000Z", null, null],
		["revenue-completed", "completed", 90, "2026-10-05T11:30:00.000Z", null, null],
		["revenue-rejected", "rejected", 90, "2026-10-05T12:00:00.000Z", null, "2026-10-05T11:00:00.000Z"],
		["revenue-cancelled", "pending", 40, "2026-10-05T12:30:00.000Z", "2026-10-05T11:05:00.000Z", null],
	] as const;
	for (const [index, [id, status, total, readyAt, cancelledAt, rejectedAt]] of orders.entries()) {
		await env.DB.prepare(
			`INSERT INTO orders (
				id, public_lookup_token, order_number, status, total_amount, original_total_amount,
				estimated_ready_at, created_at, customer_name, customer_phone, special_order,
				idempotency_key, request_fingerprint, cancelled_at, rejected_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-10-05T10:00:00.000Z', '顧客', '未提供', 0, ?, ?, ?, ?)`,
		).bind(id, (index + 1).toString(16).repeat(64), id, status, total, total, readyAt, `${id}-key`, "a".repeat(64), cancelledAt, rejectedAt).run();
	}
	await env.DB.batch([
		env.DB.prepare("INSERT INTO order_items (id, order_id, menu_item_id, item_name, unit_price, quantity, line_total, sort_order) VALUES ('revenue-line-1', 'revenue-pending', 801, '雞排快照', 90, 2, 180, 0), ('revenue-line-2', 'revenue-accepted', 802, '薯條快照', 40, 1, 40, 0), ('revenue-line-3', 'revenue-completed', 801, '雞排快照', 90, 1, 90, 0), ('revenue-line-4', 'revenue-rejected', 801, '雞排快照', 90, 1, 90, 0), ('revenue-line-5', 'revenue-cancelled', 802, '薯條快照', 40, 1, 40, 0)"),
	]);
});

describe("Merchant revenue summary", () => {
	it("counts system-effective Orders, excludes rejected/cancelled, and uses snapshots", async () => {
		const result = await getMerchantRevenueSummary(env.DB, new Date("2026-10-05T13:00:00.000Z"));
		expect(result).toMatchObject({
			businessDate: "2026-10-05",
			revenue: 310,
			effectiveOrderCount: 3,
			averageOrderValue: 103,
			itemQuantity: 4,
			busiestHour: "18:00",
			cancelledCount: 1,
			rejectedCount: 1,
			topItems: [
				{ name: "雞排快照", quantity: 3 },
				{ name: "薯條快照", quantity: 1 },
			],
			soldOutItems: [{ id: 801, name: "雞排快照" }],
		});
	});
});
