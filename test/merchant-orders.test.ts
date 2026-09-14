import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	MerchantOrderError,
	transitionMerchantOrder,
	type MerchantOrderAction,
	type OrderStatus,
} from "../src/worker/merchant-orders";

const fixedNow = new Date("2026-09-06T05:00:00.000Z");
const fixedNowIso = fixedNow.toISOString();
const fixedEta = "2026-09-06T06:00:00.000Z";

function lookupToken(id: string) {
	return Array.from({ length: 64 }, (_, index) =>
		((id.charCodeAt(index % id.length) + index) % 16).toString(16),
	).join("");
}

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (1, '目前分類', 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (1, 1, '目前雞排', '', 95, 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_groups (id, menu_item_id, name, selection_type, is_required, sort_order, is_active) VALUES (1, 1, '目前辣度', 'single', 1, 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_options (id, modifier_group_id, name, price_delta, sort_order, is_active) VALUES (1, 1, '目前小辣', 10, 10, 1)",
		),
	]);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM store_state_events"),
		env.DB.prepare(
			"UPDATE store_settings SET is_accepting_orders = 0, state_version = 0 WHERE id = 1",
		),
		env.DB.prepare("DELETE FROM order_item_modifiers"),
		env.DB.prepare("DELETE FROM order_items"),
		env.DB.prepare("DELETE FROM orders"),
		env.DB.prepare("UPDATE menu_items SET name = '目前雞排', price = 95 WHERE id = 1"),
		env.DB.prepare("UPDATE modifier_groups SET name = '目前辣度' WHERE id = 1"),
		env.DB.prepare(
			"UPDATE modifier_options SET name = '目前小辣', price_delta = 10 WHERE id = 1",
		),
	]);
});

async function insertOrder({
	id,
	status,
	createdAt = "2026-09-06T04:00:00.000Z",
	itemName = "雞排快照",
}: {
	id: string;
	status: OrderStatus;
	createdAt?: string;
	itemName?: string;
}) {
	const acceptedAt = status === "accepted" || status === "completed" ? "2026-09-06T04:10:00.000Z" : null;
	const completedAt = status === "completed" ? "2026-09-06T04:30:00.000Z" : null;
	const rejectedAt = status === "rejected" ? "2026-09-06T04:10:00.000Z" : null;

	await env.DB.batch([
		env.DB
			.prepare(
				`INSERT INTO orders (
					id, public_lookup_token, order_number, status, total_amount, estimated_ready_at, created_at,
					accepted_at, completed_at, rejected_at, customer_name, customer_phone,
					special_order, idempotency_key, request_fingerprint
				) VALUES (?, ?, ?, ?, 90, ?, ?, ?, ?, ?, '王小明', '0912345678', 0, ?, ?)`,
			)
			.bind(
				id,
				lookupToken(id),
				`ORDER-${id}`,
				status,
				fixedEta,
				createdAt,
				acceptedAt,
				completedAt,
				rejectedAt,
				`key-${id}`,
				"a".repeat(64),
			),
		env.DB
			.prepare(
				`INSERT INTO order_items (
					id, order_id, menu_item_id, item_name, unit_price, quantity, line_total, sort_order
				) VALUES (?, ?, 1, ?, 90, 1, 90, 0)`,
			)
			.bind(`${id}-item`, id, itemName),
		env.DB
			.prepare(
				`INSERT INTO order_item_modifiers (
					id, order_item_id, modifier_option_id, modifier_group_name,
					modifier_option_name, price_delta, sort_order
				) VALUES (?, ?, 1, '辣度快照', '小辣快照', 5, 0)`,
			)
			.bind(`${id}-modifier`, `${id}-item`),
	]);
}

async function readStatus(orderId: string) {
	return env.DB
		.prepare(
			"SELECT status, accepted_at, completed_at, rejected_at, estimated_ready_at FROM orders WHERE id = ?",
		)
		.bind(orderId)
		.first<{
			status: OrderStatus;
			accepted_at: string | null;
			completed_at: string | null;
			rejected_at: string | null;
			estimated_ready_at: string;
		}>();
}

async function expectIllegal(orderId: string, action: MerchantOrderAction) {
	await expect(transitionMerchantOrder(env.DB, orderId, action, fixedNow)).rejects.toMatchObject({
		status: 409,
		code: "ILLEGAL_ORDER_TRANSITION",
	});
}

describe("Merchant Order state machine", () => {
	it("accepts pending Orders and sets only accepted_at", async () => {
		await insertOrder({ id: "accept-order", status: "pending" });

		const order = await transitionMerchantOrder(env.DB, "accept-order", "accept", fixedNow);
		const stored = await readStatus("accept-order");

		expect(order.status).toBe("accepted");
		expect(stored).toEqual({
			status: "accepted",
			accepted_at: fixedNowIso,
			completed_at: null,
			rejected_at: null,
			estimated_ready_at: fixedEta,
		});
	});

	it("rejects pending Orders and sets only rejected_at", async () => {
		await insertOrder({ id: "reject-order", status: "pending" });
		const storeBefore = await env.DB.prepare(
			"SELECT is_accepting_orders, state_version FROM store_settings WHERE id = 1",
		).first();

		const order = await transitionMerchantOrder(env.DB, "reject-order", "reject", fixedNow);
		const stored = await readStatus("reject-order");
		const storeAfter = await env.DB.prepare(
			`SELECT is_accepting_orders, state_version,
				(SELECT COUNT(*) FROM store_state_events) AS event_count
			FROM store_settings WHERE id = 1`,
		).first<Record<string, unknown>>();

		expect(order.status).toBe("rejected");
		expect(stored).toEqual({
			status: "rejected",
			accepted_at: null,
			completed_at: null,
			rejected_at: fixedNowIso,
			estimated_ready_at: fixedEta,
		});
		expect(storeAfter).toEqual({ ...storeBefore, event_count: 0 });
	});

	it("completes accepted Orders, preserves accepted_at, and sets only completed_at", async () => {
		await insertOrder({ id: "complete-order", status: "accepted" });

		const order = await transitionMerchantOrder(env.DB, "complete-order", "complete", fixedNow);
		const stored = await readStatus("complete-order");

		expect(order.status).toBe("completed");
		expect(stored).toEqual({
			status: "completed",
			accepted_at: "2026-09-06T04:10:00.000Z",
			completed_at: fixedNowIso,
			rejected_at: null,
			estimated_ready_at: fixedEta,
		});
	});

	it.each<[OrderStatus, MerchantOrderAction]>([
		["pending", "complete"],
		["accepted", "reject"],
		["completed", "accept"],
		["completed", "reject"],
		["rejected", "accept"],
		["rejected", "complete"],
	])("rejects the illegal %s -> %s transition", async (status, action) => {
		await insertOrder({ id: "illegal-order", status });
		await expectIllegal("illegal-order", action);
		expect((await readStatus("illegal-order"))?.status).toBe(status);
	});

	it("rejects repeated accept", async () => {
		await insertOrder({ id: "repeat-accept", status: "pending" });
		await transitionMerchantOrder(env.DB, "repeat-accept", "accept", fixedNow);
		await expectIllegal("repeat-accept", "accept");
	});

	it("rejects repeated complete", async () => {
		await insertOrder({ id: "repeat-complete", status: "accepted" });
		await transitionMerchantOrder(env.DB, "repeat-complete", "complete", fixedNow);
		await expectIllegal("repeat-complete", "complete");
	});

	it("allows accept to win over a later competing reject", async () => {
		await insertOrder({ id: "accept-wins", status: "pending" });
		await transitionMerchantOrder(env.DB, "accept-wins", "accept", fixedNow);
		await expectIllegal("accept-wins", "reject");
		expect((await readStatus("accept-wins"))?.status).toBe("accepted");
	});

	it("allows reject to win over a later competing accept", async () => {
		await insertOrder({ id: "reject-wins", status: "pending" });
		await transitionMerchantOrder(env.DB, "reject-wins", "reject", fixedNow);
		await expectIllegal("reject-wins", "accept");
		expect((await readStatus("reject-wins"))?.status).toBe("rejected");
	});

	it("returns 404 for a missing Order", async () => {
		await expect(
			transitionMerchantOrder(env.DB, "missing-order", "accept", fixedNow),
		).rejects.toBeInstanceOf(MerchantOrderError);

		await expect(
			transitionMerchantOrder(env.DB, "missing-order", "accept", fixedNow),
		).rejects.toMatchObject({ status: 404, code: "ORDER_NOT_FOUND" });
	});
});

describe("Merchant Order API", () => {
	it("returns active Orders oldest first using stored item and modifier snapshots", async () => {
		await insertOrder({ id: "newer", status: "pending", createdAt: "2026-09-06T04:02:00.000Z" });
		await insertOrder({ id: "oldest", status: "pending", createdAt: "2026-09-06T04:00:00.000Z" });
		await insertOrder({ id: "accepted", status: "accepted", createdAt: "2026-09-06T04:01:00.000Z" });
		await insertOrder({ id: "completed", status: "completed", createdAt: "2026-09-06T03:58:00.000Z" });
		await insertOrder({ id: "rejected", status: "rejected", createdAt: "2026-09-06T03:59:00.000Z" });
		await env.DB.batch([
			env.DB.prepare("UPDATE menu_items SET name = '已改名雞排', price = 120 WHERE id = 1"),
			env.DB.prepare("UPDATE modifier_groups SET name = '已改名辣度' WHERE id = 1"),
			env.DB.prepare(
				"UPDATE modifier_options SET name = '已改名小辣', price_delta = 25 WHERE id = 1",
			),
		]);

		const response = await exports.default.fetch("https://example.com/api/merchant/orders");
		const result = (await response.json()) as {
			orders: Array<{
				id: string;
				items: Array<{
					name: string;
					unitPrice: number;
					modifiers: Array<{ groupName: string; name: string; priceDelta: number }>;
				}>;
			}>;
		};

		expect(response.status).toBe(200);
		expect(result.orders.map((order) => order.id)).toEqual(["oldest", "accepted", "newer"]);
		expect(result.orders[0].items[0]).toMatchObject({
			name: "雞排快照",
			unitPrice: 90,
			modifiers: [{ groupName: "辣度快照", name: "小辣快照", priceDelta: 5 }],
		});
	});

	it("exposes guarded explicit action endpoints", async () => {
		await insertOrder({ id: "route-order", status: "pending" });

		const accepted = await exports.default.fetch(
			"https://example.com/api/merchant/orders/route-order/accept",
			{
				method: "POST",
				headers: { Origin: "https://example.com", "Sec-Fetch-Site": "same-origin" },
			},
		);
		const illegalReject = await exports.default.fetch(
			"https://example.com/api/merchant/orders/route-order/reject",
			{
				method: "POST",
				headers: { Origin: "https://example.com", "Sec-Fetch-Site": "same-origin" },
			},
		);

		expect(accepted.status).toBe(200);
		expect(await accepted.json()).toMatchObject({ order: { id: "route-order", status: "accepted" } });
		expect(illegalReject.status).toBe(409);
		expect(await illegalReject.json()).toMatchObject({
			error: { code: "ILLEGAL_ORDER_TRANSITION" },
		});
	});
});
