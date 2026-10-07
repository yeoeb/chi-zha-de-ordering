import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createOrder, type CreateOrderRequest } from "../src/worker/order-creation";
import { createQuoteFingerprint, validateAndPriceCart } from "../src/worker/checkout-quote";
import { cancelCustomerOrder } from "../src/worker/order-adjustments";
import { listActiveMerchantOrders, transitionMerchantOrder } from "../src/worker/merchant-orders";
import { getCustomerOrder } from "../src/worker/customer-orders";
import { performBusyModeOperation, processDueAutoRejections } from "../src/worker/operational-automation";

const now = new Date("2030-10-07T11:00:00.000Z");
const items = [{ menuItemId: 980, quantity: 1, modifierOptionIds: [] }];
let request: CreateOrderRequest;
beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM order_auto_rejection_events"),
		env.DB.prepare("DELETE FROM store_busy_mode_events"),
		env.DB.prepare("DELETE FROM web_push_notification_deliveries"),
		env.DB.prepare("DELETE FROM notification_deliveries"),
		env.DB.prepare("DELETE FROM order_item_modifiers"),
		env.DB.prepare("DELETE FROM order_items"),
		env.DB.prepare("DELETE FROM orders"),
		env.DB.prepare("INSERT OR IGNORE INTO menu_categories (id,name,sort_order,is_active) VALUES (980,'測試',10,1)"),
		env.DB.prepare("INSERT OR IGNORE INTO menu_items (id,category_id,name,price,sort_order,is_available) VALUES (980,980,'測試餐點',50,10,1)"),
		env.DB.prepare("UPDATE store_settings SET state_version=0,missed_order_count=0,base_prep_minutes=15,normal_order_minutes=5,special_extra_minutes=10,busy_mode=0,is_accepting_orders=1 WHERE id=1"),
	]);
	request = { orderSource: "online", customerName: "測試", customerPhone: "0912345678", specialOrder: false,
		items, quoteFingerprint: await createQuoteFingerprint(await validateAndPriceCart(env.DB, items)) };
});
const create = (key: string, source: "online" | "onsite" = "online") => createOrder(env.DB, { ...request, orderSource: source }, key, now);
async function assertUnique() {
	const { results } = await env.DB.prepare("SELECT strftime('%Y-%m-%dT%H:%M',estimated_ready_at) AS slot,COUNT(*) AS count FROM orders WHERE status IN ('pending','accepted') AND cancelled_at IS NULL GROUP BY slot HAVING COUNT(*)>1").all();
	expect(results).toEqual([]);
}

describe("authoritative unique pickup identifiers", () => {
	it.each(["online", "onsite"] as const)("racing %s creates get different five-minute times and one intent per Order", async (source) => {
		const results = await Promise.all([create("race-a", source), create("race-b", source)]);
		expect(new Set(results.map(({ order }) => order.estimatedReadyAt)).size).toBe(2);
		for (const { order } of results) expect(Date.parse(order.estimatedReadyAt) % 300000).toBe(0);
		expect(await env.DB.prepare("SELECT (SELECT COUNT(*) FROM orders) AS orders,(SELECT COUNT(*) FROM order_items) AS items,(SELECT COUNT(*) FROM web_push_notification_deliveries) AS intents").first()).toEqual({ orders: 2, items: 2, intents: 2 });
		await assertUnique();
	});
	it("online and onsite race through the same authoritative queue", async () => {
		const results = await Promise.all([create("mixed-a"), create("mixed-b", "onsite")]);
		expect(results[0].order.estimatedReadyAt).not.toBe(results[1].order.estimatedReadyAt);
		await assertUnique();
	});
	it("replay neither creates another slot nor re-schedules the stored order", async () => {
		const first = await create("replay");
		await create("another");
		const retry = await create("replay");
		expect(retry.replayed).toBe(true);
		expect(retry.order.id).toBe(first.order.id);
		expect(retry.order.estimatedReadyAt).toBe(first.order.estimatedReadyAt);
		await assertUnique();
	});
	it.each(["cancel", "reject", "complete"] as const)("%s releases a slot without deleting snapshots; next Order can reuse it", async (action) => {
		const first = await create("release-first");
		if (action === "cancel") await cancelCustomerOrder(env.DB, first.order.publicLookupToken, now);
		else {
			if (action === "complete") await transitionMerchantOrder(env.DB, first.order.id, "accept", now);
			await transitionMerchantOrder(env.DB, first.order.id, action, now);
		}
		const second = await create("release-next");
		expect(second.order.estimatedReadyAt).toBe(first.order.estimatedReadyAt);
		expect(await env.DB.prepare("SELECT item_name,quantity,unit_price FROM order_items WHERE order_id=?").bind(first.order.id).first()).toEqual({ item_name: "測試餐點", quantity: 1, unit_price: 50 });
		await assertUnique();
	});
	it("automatic rejection releases only due pending Orders; accepted deadlines retain their actual state", async () => {
		const first = await create("auto");
		const { rejectedOrderIds } = await processDueAutoRejections(env.DB, new Date(now.getTime() + 5 * 60000));
		expect(rejectedOrderIds).toContain(first.order.id);
		await assertUnique();
		const accepted = await create("accepted");
		await transitionMerchantOrder(env.DB, accepted.order.id, "accept", now);
		await processDueAutoRejections(env.DB, new Date(Date.parse(accepted.order.estimatedReadyAt) + 60000));
		expect((await getCustomerOrder(env.DB, accepted.order.publicLookupToken))?.status).toBe("accepted");
	});
	it("released onsite capacity compacts in order, respects preparation floor and updates both views", async () => {
		const first = await create("compact-a", "onsite");
		const second = await create("compact-b", "onsite");
		const third = await create("compact-c", "onsite");
		await transitionMerchantOrder(env.DB, first.order.id, "reject", now);
		const customer = await getCustomerOrder(env.DB, second.order.publicLookupToken);
		const merchant = await listActiveMerchantOrders(env.DB, now);
		expect(customer?.estimatedReadyAt).toBe(first.order.estimatedReadyAt);
		expect(merchant.find((order) => order.id === second.order.id)?.estimatedReadyAt).toBe(customer?.estimatedReadyAt);
		expect(Date.parse(customer!.estimatedReadyAt)).toBeGreaterThanOrEqual(now.getTime() + 20 * 60000);
		expect(merchant.find((order) => order.id === third.order.id)?.estimatedReadyAt).toBe(second.order.estimatedReadyAt);
		await create("compact-next", "onsite");
		await assertUnique();
	});
	it("busy mode allocates distinct extensions around fixed reservations and concurrent new orders", async () => {
		await create("busy-a");
		await create("busy-b");
		await Promise.all([
			performBusyModeOperation({ db: env.DB, actorSubject: "local-test", auditActorHashKey: "test-only-audit-key".repeat(3), now,
				request: { operationId: crypto.randomUUID(), expectedBusyMode: false, expectedStateVersion: 0, busyMode: true } }),
			create("busy-racing"),
		]);
		await assertUnique();
		// Retry with a NEW operation only when the original CAS was stale.
		const store = await env.DB.prepare("SELECT busy_mode AS busyMode,state_version AS version FROM store_settings WHERE id=1").first<{ busyMode: number; version: number }>();
		if (!store!.busyMode) await performBusyModeOperation({ db: env.DB, actorSubject: "local-test", auditActorHashKey: "test-only-audit-key".repeat(3), now,
			request: { operationId: crypto.randomUUID(), expectedBusyMode: false, expectedStateVersion: store!.version, busyMode: true } });
		const active = await listActiveMerchantOrders(env.DB, now);
		expect(active.every((order) => Date.parse(order.estimatedReadyAt) >= now.getTime() + 30 * 60000)).toBe(true);
		await assertUnique();
	});
	it("a guarded busy extension separates legacy pending collisions without rewriting snapshots", async () => {
		const first = await create("legacy-a");
		const second = await create("legacy-b");
		// Reproduce data written by the previous shared-minimum busy UPDATE.
		await env.DB.prepare("UPDATE orders SET estimated_ready_at=? WHERE id=?").bind(first.order.estimatedReadyAt, second.order.id).run();
		const result = await performBusyModeOperation({ db: env.DB, actorSubject: "local-test", auditActorHashKey: "test-only-audit-key".repeat(3), now,
			request: { operationId: crypto.randomUUID(), expectedBusyMode: false, expectedStateVersion: 0, busyMode: true } });
		expect(result.outcome).toBe("APPLIED");
		expect(result.extendedOrderCount).toBe(2);
		await assertUnique();
		expect(await env.DB.prepare("SELECT COUNT(*) AS items,SUM(line_total) AS total FROM order_items").first()).toEqual({ items: 2, total: 100 });
	});
});
