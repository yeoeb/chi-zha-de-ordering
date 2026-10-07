import { setupOrderAcceptanceTests } from "./order-acceptance-fixture";
import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	cancelCustomerOrder,
	markOrderShortage,
	OrderAdjustmentError,
} from "../src/worker/order-adjustments";
import { getOrderSnapshotById } from "../src/worker/merchant-orders";
import { dailyTestSchedule } from "./business-hours-fixture";
import { restorePreviousBusinessDaySoldOut } from "../src/worker/daily-sold-out";

const now = new Date("2026-09-25T04:00:00.000Z");

setupOrderAcceptanceTests();

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare("INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (930, '調整測試', 930, 1)"),
		env.DB.prepare("INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (930, 930, '測試雞排', '', 80, 10, 1), (931, 930, '測試薯條', '', 40, 20, 1)"),
	]);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM order_shortage_requests"),
		env.DB.prepare("DELETE FROM order_item_shortages"),
		env.DB.prepare("DELETE FROM order_item_modifiers"),
		env.DB.prepare("DELETE FROM order_items"),
		env.DB.prepare("DELETE FROM orders"),
		env.DB.prepare("UPDATE store_settings SET is_accepting_orders = 1 WHERE id = 1"),
		env.DB.prepare("UPDATE store_settings SET weekly_business_hours = ? WHERE id = 1").bind(JSON.stringify(dailyTestSchedule)),
		env.DB.prepare("UPDATE menu_items SET is_available = 1, sold_out_business_date = NULL WHERE id IN (930, 931)"),
	]);
});

async function insertOrder(id: string, policy: "continue_available" | "cancel_entire_order" = "continue_available", source: "online" | "onsite" = "online") {
	const token = id.padEnd(64, "a").slice(0, 64).replace(/[^a-f0-9]/g, "a");
	await env.DB.batch([
		env.DB.prepare(`INSERT INTO orders (
			id, public_lookup_token, order_number, status, order_source, total_amount, original_total_amount,
			estimated_ready_at, created_at, customer_name, customer_phone, shortage_policy,
			special_order, idempotency_key, request_fingerprint
		) VALUES (?, ?, ?, 'pending', ?, 200, 200, '2026-09-25T04:30:00.000Z',
			'2026-09-25T03:55:00.000Z', '王小明', '0912345678', ?, 0, ?, ?)`)
			.bind(id, token, `ADJ-${id}`, source, policy, `key-${id}`, "a".repeat(64)),
		env.DB.prepare("INSERT INTO order_items (id, order_id, menu_item_id, item_name, unit_price, quantity, line_total, sort_order) VALUES (?, ?, 930, '測試雞排', 80, 2, 160, 0)").bind(`${id}-a`, id),
		env.DB.prepare("INSERT INTO order_items (id, order_id, menu_item_id, item_name, unit_price, quantity, line_total, sort_order) VALUES (?, ?, 931, '測試薯條', 40, 1, 40, 1)").bind(`${id}-b`, id),
	]);
	return token;
}

describe("Order shortage and Customer cancellation", () => {
	it("ignores legacy onsite customer preference while retaining partial shortage and sold-out effects", async () => {
		await insertOrder("onsite-policy", "cancel_entire_order", "onsite");
		const result = await markOrderShortage(env.DB, "onsite-policy", {
			requestId: "onsite-policy-shortage",
			items: [{ orderItemId: "onsite-policy-b", quantity: 1 }],
		}, now);
		expect(result.order).toMatchObject({ orderSource: "onsite", shortagePolicy: null, status: "pending", total: 160, originalTotal: 200 });
		expect(result.order.items).toHaveLength(1);
		expect(result.order.items[0]).toMatchObject({ name: "測試雞排", quantity: 2, lineTotal: 160 });
		expect(result.order.shortages).toEqual([{ orderItemId: "onsite-policy-b", name: "測試薯條", quantity: 1, amountDeducted: 40 }]);
		expect(await env.DB.prepare("SELECT is_available AS available,sold_out_business_date AS day FROM menu_items WHERE id=931").first()).toEqual({ available: 0, day: "2026-09-24" });
		expect(await env.DB.prepare("SELECT shortage_policy AS policy FROM orders WHERE id='onsite-policy'").first()).toEqual({ policy: "cancel_entire_order" });
	});

	it("persists the Checkout shortage policy and includes it in idempotent creation", async () => {
		const items = [{ menuItemId: 930, quantity: 1, modifierOptionIds: [] }];
		const quoteResponse = await exports.default.fetch("https://example.com/api/checkout/quote", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
		});
		const quote = await quoteResponse.json() as { quoteFingerprint: string };
		const body = {
			customerName: "王小明", customerPhone: "0912345678", customerNote: null,
			packagingPreference: "together" as const, shortagePolicy: "cancel_entire_order" as const,
			specialOrder: false, quoteFingerprint: quote.quoteFingerprint, items,
		};
		const response = await exports.default.fetch("https://example.com/api/orders", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": "shortage-policy-create" },
			body: JSON.stringify(body),
		});
		expect(response.status).toBe(201);
		expect(await env.DB.prepare("SELECT shortage_policy AS policy, original_total_amount AS originalTotal FROM orders WHERE idempotency_key = 'shortage-policy-create'").first()).toEqual({ policy: "cancel_entire_order", originalTotal: 80 });

		const stored = await env.DB.prepare(
			"SELECT orders.id AS orderId, order_items.id AS orderItemId FROM orders JOIN order_items ON order_items.order_id = orders.id WHERE orders.idempotency_key = ?",
		).bind("shortage-policy-create").first<{ orderId: string; orderItemId: string }>();
		await markOrderShortage(env.DB, stored!.orderId, {
			requestId: "shortage-created-replay",
			items: [{ orderItemId: stored!.orderItemId, quantity: 1 }],
		}, now);
		const replay = await exports.default.fetch("https://example.com/api/orders", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": "shortage-policy-create" },
			body: JSON.stringify(body),
		});
		const replayResult = await replay.json() as { order: { status: string; total: number; items: unknown[]; shortages: unknown[] } };
		expect(replay.status).toBe(200);
		expect(replayResult.order).toMatchObject({ status: "cancelled", total: 0, items: [] });
		expect(replayResult.order.shortages).toHaveLength(1);
	});

	it("deducts only the unavailable snapshot quantity and replays the same request once", async () => {
		await insertOrder("continue");
		const request = { requestId: "shortage-request-0001", items: [{ orderItemId: "continue-a", quantity: 1 }] };
		const first = await markOrderShortage(env.DB, "continue", request, now);
		expect(first.replayed).toBe(false);
		expect(first.order).toMatchObject({ total: 120, originalTotal: 200, shortageRevision: 1, status: "pending" });
		expect(first.order.items.find((item) => item.name === "測試雞排")?.quantity).toBe(1);
		expect(first.order.shortages).toEqual([{ orderItemId: "continue-a", name: "測試雞排", quantity: 1, amountDeducted: 80 }]);
		expect(await env.DB.prepare("SELECT is_available AS isAvailable FROM menu_items WHERE id = 930").first()).toEqual({ isAvailable: 0 });
		expect(await env.DB.prepare("SELECT sold_out_business_date AS day FROM menu_items WHERE id = 930").first()).toEqual({ day: "2026-09-24" });
		expect(await env.DB.prepare("SELECT is_available AS isAvailable FROM menu_items WHERE id = 931").first()).toEqual({ isAvailable: 1 });

		const replay = await markOrderShortage(env.DB, "continue", request, now);
		expect(replay.replayed).toBe(true);
		expect(replay.order.total).toBe(120);
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM order_shortage_requests").first<{ count: number }>()).toEqual({ count: 1 });
	});

	it("atomically marks every targeted Menu Item sold out without touching unrelated products", async () => {
		await insertOrder("multi-sold-out");
		await markOrderShortage(env.DB, "multi-sold-out", {
			requestId: "shortage-request-multi-sold-out",
			items: [
				{ orderItemId: "multi-sold-out-a", quantity: 1 },
				{ orderItemId: "multi-sold-out-b", quantity: 1 },
			],
		}, now);
		expect(await env.DB.prepare("SELECT id, is_available AS isAvailable FROM menu_items WHERE id IN (930, 931) ORDER BY id").all()).toMatchObject({
			results: [{ id: 930, isAvailable: 0 }, { id: 931, isAvailable: 0 }],
		});
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM order_item_shortages WHERE order_item_id LIKE 'multi-sold-out-%'").first()).toEqual({ count: 2 });
	});

	it("rolls back the shortage and request when the paired availability write fails", async () => {
		await insertOrder("atomic-failure");
		await env.DB.prepare(`CREATE TRIGGER force_shortage_availability_failure
			BEFORE UPDATE OF is_available ON menu_items
			WHEN NEW.id = 930 AND NEW.is_available = 0
			BEGIN SELECT RAISE(ABORT, 'forced availability failure'); END`).run();
		try {
			await expect(markOrderShortage(env.DB, "atomic-failure", {
				requestId: "shortage-request-atomic-failure",
				items: [{ orderItemId: "atomic-failure-a", quantity: 1 }],
			}, now)).rejects.toThrow();
		} finally {
			await env.DB.prepare("DROP TRIGGER IF EXISTS force_shortage_availability_failure").run();
		}
		expect(await env.DB.prepare("SELECT total_amount AS total, shortage_revision AS revision FROM orders WHERE id = 'atomic-failure'").first()).toEqual({ total: 200, revision: 0 });
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM order_item_shortages WHERE order_item_id = 'atomic-failure-a'").first()).toEqual({ count: 0 });
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM order_shortage_requests WHERE id = 'shortage-request-atomic-failure'").first()).toEqual({ count: 0 });
		expect(await env.DB.prepare("SELECT is_available AS isAvailable FROM menu_items WHERE id = 930").first()).toEqual({ isAvailable: 1 });
		expect(await env.DB.prepare("SELECT sold_out_business_date AS day FROM menu_items WHERE id = 930").first()).toEqual({ day: null });
	});

	it("shortage replay after a new opening never marks the restored item sold-out again", async () => {
		await insertOrder("day-replay");
		const request = { requestId: "daily-shortage-replay", items: [{ orderItemId: "day-replay-a", quantity: 1 }] };
		await markOrderShortage(env.DB, "day-replay", request, now);
		await restorePreviousBusinessDaySoldOut(env.DB, new Date("2026-09-25T09:30:00Z"));
		const result = await markOrderShortage(env.DB, "day-replay", request, new Date("2026-09-25T09:31:00Z"));
		expect(result.replayed).toBe(true);
		expect(result.order.total).toBe(120);
		expect(await env.DB.prepare("SELECT is_available AS available,sold_out_business_date AS day FROM menu_items WHERE id=930").first()).toEqual({ available: 1, day: null });
	});

	it("unconfigured schedule rejects shortage before any order/menu/ledger mutation", async () => {
		await insertOrder("day-config-gap");
		await env.DB.prepare("UPDATE store_settings SET weekly_business_hours=NULL WHERE id=1").run();
		await expect(markOrderShortage(env.DB, "day-config-gap", {
			requestId: "daily-shortage-config-gap", items: [{ orderItemId: "day-config-gap-a", quantity: 1 }],
		}, now)).rejects.toMatchObject({ code: "BUSINESS_SCHEDULE_UNAVAILABLE", status: 409 });
		expect(await env.DB.prepare("SELECT total_amount AS total,shortage_revision AS revision FROM orders WHERE id='day-config-gap'").first()).toEqual({ total: 200, revision: 0 });
		expect(await env.DB.prepare("SELECT is_available AS available,sold_out_business_date AS day FROM menu_items WHERE id=930").first()).toEqual({ available: 1, day: null });
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM order_shortage_requests WHERE id='daily-shortage-config-gap'").first()).toEqual({ count: 0 });
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM order_item_shortages WHERE order_item_id='day-config-gap-a'").first()).toEqual({ count: 0 });
	});

	it("rejects a reused shortage request ID when its payload differs", async () => {
		await insertOrder("request-conflict");
		const requestId = "shortage-request-conflict";
		await markOrderShortage(env.DB, "request-conflict", {
			requestId,
			items: [{ orderItemId: "request-conflict-a", quantity: 1 }],
		}, now);

		await expect(markOrderShortage(env.DB, "request-conflict", {
			requestId,
			items: [{ orderItemId: "request-conflict-b", quantity: 1 }],
		}, now)).rejects.toMatchObject({ code: "ORDER_ADJUSTMENT_CONFLICT" });
		expect((await getOrderSnapshotById(env.DB, "request-conflict"))?.total).toBe(120);
	});

	it("cancels the whole Order according to the saved policy and preserves the original snapshot", async () => {
		await insertOrder("cancel-all", "cancel_entire_order");
		const result = await markOrderShortage(env.DB, "cancel-all", {
			requestId: "shortage-request-0002",
			items: [{ orderItemId: "cancel-all-b", quantity: 1 }],
		}, now);
		expect(result.order).toMatchObject({ status: "cancelled", total: 0, originalTotal: 200, cancellationReason: "shortage_cancelled" });
		const raw = await env.DB.prepare("SELECT quantity, line_total FROM order_items WHERE id = 'cancel-all-b'").first();
		expect(raw).toEqual({ quantity: 1, line_total: 40 });
	});

	it("rejects excessive and duplicate shortages without changing money", async () => {
		await insertOrder("invalid");
		await expect(markOrderShortage(env.DB, "invalid", {
			requestId: "shortage-request-0003",
			items: [{ orderItemId: "invalid-a", quantity: 3 }],
		}, now)).rejects.toBeInstanceOf(OrderAdjustmentError);
		expect((await getOrderSnapshotById(env.DB, "invalid"))?.total).toBe(200);
	});

	it("allows pending online cancellation through the ten-minute boundary and is idempotent", async () => {
		const token = await insertOrder("customer-cancel");
		const first = await cancelCustomerOrder(env.DB, token, new Date("2026-09-25T04:20:00.000Z"));
		expect(first.order).toMatchObject({ status: "cancelled", total: 0, originalTotal: 200, cancellationReason: "customer_cancelled" });
		const replay = await cancelCustomerOrder(env.DB, token, new Date("2026-09-25T04:21:00.000Z"));
		expect(replay.replayed).toBe(true);
	});

	it("blocks late online and accepted cancellation while onsite pending can cancel", async () => {
		const lateToken = await insertOrder("late");
		await expect(cancelCustomerOrder(env.DB, lateToken, new Date("2026-09-25T04:20:00.001Z"))).rejects.toMatchObject({ code: "CANCELLATION_DEADLINE_PASSED" });
		await env.DB.prepare("UPDATE orders SET status = 'accepted' WHERE id = 'late'").run();
		await expect(cancelCustomerOrder(env.DB, lateToken, now)).rejects.toMatchObject({ code: "CANCELLATION_NOT_ALLOWED" });
		const onsiteToken = await insertOrder("onsite-cancel", "continue_available", "onsite");
		expect((await cancelCustomerOrder(env.DB, onsiteToken, new Date("2026-09-25T05:00:00.000Z"))).order.status).toBe("cancelled");
	});

	it("requires same-origin confirmation for the public cancellation route", async () => {
		const token = await insertOrder("route-cancel", "continue_available", "onsite");
		const path = `https://example.com/api/orders/by-token/${token}/cancel`;
		const denied = await exports.default.fetch(path, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
			body: JSON.stringify({ confirm: true }),
		});
		expect(denied.status).toBe(403);
		expect((await getOrderSnapshotById(env.DB, "route-cancel"))?.status).toBe("pending");

		const allowed = await exports.default.fetch(path, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "https://example.com", "Sec-Fetch-Site": "same-origin" },
			body: JSON.stringify({ confirm: true }),
		});
		expect(allowed.status).toBe(200);
		expect(await allowed.json()).toMatchObject({ order: { status: "cancelled", cancellationReason: "customer_cancelled" } });
	});
});
