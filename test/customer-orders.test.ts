import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OrderStatus } from "../src/worker/merchant-orders";

const persistedEta = "2026-09-06T06:30:00.000Z";

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
			"INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (1, 1, '目前雞排', '', 120, 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_groups (id, menu_item_id, name, selection_type, is_required, sort_order, is_active) VALUES (1, 1, '目前辣度', 'single', 1, 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_options (id, modifier_group_id, name, price_delta, sort_order, is_active) VALUES (1, 1, '目前小辣', 20, 10, 1)",
		),
	]);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM order_item_modifiers"),
		env.DB.prepare("DELETE FROM order_items"),
		env.DB.prepare("DELETE FROM orders"),
		env.DB.prepare("UPDATE menu_items SET name = '目前雞排', price = 120 WHERE id = 1"),
		env.DB.prepare("UPDATE modifier_groups SET name = '目前辣度' WHERE id = 1"),
		env.DB.prepare(
			"UPDATE modifier_options SET name = '目前小辣', price_delta = 20 WHERE id = 1",
		),
	]);
});

async function insertOrder(
	id: string,
	status: OrderStatus = "pending",
	customerNote: string | null = null,
	packagingPreference: "together" | "separate_spicy" = "together",
) {
	const acceptedAt = status === "accepted" || status === "completed" ? "2026-09-06T05:15:00.000Z" : null;
	const completedAt = status === "completed" ? "2026-09-06T05:45:00.000Z" : null;
	const rejectedAt = status === "rejected" ? "2026-09-06T05:15:00.000Z" : null;

	await env.DB.batch([
		env.DB
			.prepare(
				`INSERT INTO orders (
					id, public_lookup_token, order_number, status, total_amount, estimated_ready_at, created_at,
					accepted_at, completed_at, rejected_at, customer_name, customer_phone,
					customer_note, packaging_preference, special_order, idempotency_key, request_fingerprint
				) VALUES (?, ?, ?, ?, 90, ?, '2026-09-06T05:00:00.000Z', ?, ?, ?, '王小明',
					'0912345678', ?, ?, 0, ?, ?)`,
			)
			.bind(
				id,
				lookupToken(id),
				`ORDER-${id}`,
				status,
				persistedEta,
				acceptedAt,
				completedAt,
				rejectedAt,
				customerNote,
				packagingPreference,
				`key-${id}`,
				"c".repeat(64),
			),
		env.DB
			.prepare(
				`INSERT INTO order_items (
					id, order_id, menu_item_id, item_name, unit_price, quantity, line_total, sort_order
				) VALUES (?, ?, 1, '雞排快照', 90, 1, 90, 0)`,
			)
			.bind(`${id}-item`, id),
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

describe("GET /api/orders/by-token/:token", () => {
	it.each<OrderStatus>(["pending", "accepted", "completed", "rejected"])(
		"returns current %s status with persisted ETA and no-store",
		async (status) => {
			await insertOrder(`status-${status}`, status);

			const response = await exports.default.fetch(
				`https://example.com/api/orders/by-token/${lookupToken(`status-${status}`)}`,
			);
			const result = (await response.json()) as {
				order: Record<string, unknown> & { status: string; estimatedReadyAt: string };
			};

			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toContain("no-store");
			expect(result.order.status).toBe(status);
			expect(result.order.estimatedReadyAt).toBe(persistedEta);
			expect(result.order).not.toHaveProperty("customerPhone");
			expect(result.order).not.toHaveProperty("acceptedAt");
			expect(result.order).not.toHaveProperty("idempotencyKey");
		},
	);

	it("returns stored item and modifier snapshots after current menu changes", async () => {
		await insertOrder("snapshot-order", "pending", "雞排不要切", "separate_spicy");
		await env.DB.batch([
			env.DB.prepare("UPDATE menu_items SET name = '豪大雞排', price = 150 WHERE id = 1"),
			env.DB.prepare("UPDATE modifier_groups SET name = '新版辣度' WHERE id = 1"),
			env.DB.prepare(
				"UPDATE modifier_options SET name = '新版小辣', price_delta = 30 WHERE id = 1",
			),
		]);

		const response = await exports.default.fetch(
			`https://example.com/api/orders/by-token/${lookupToken("snapshot-order")}`,
		);
		const result = (await response.json()) as {
			order: {
				total: number;
				customerNote: string | null;
				packagingPreference: string;
				items: Array<{
					name: string;
					unitPrice: number;
					lineTotal: number;
					modifiers: Array<{ groupName: string; name: string; priceDelta: number }>;
				}>;
			};
		};

		expect(response.status).toBe(200);
		expect(result.order).toMatchObject({
			total: 90,
			customerNote: "雞排不要切",
			packagingPreference: "separate_spicy",
			items: [
				{
					name: "雞排快照",
					unitPrice: 90,
					lineTotal: 90,
					modifiers: [{ groupName: "辣度快照", name: "小辣快照", priceDelta: 5 }],
				},
			],
		});
	});

	it("returns a no-store 404 for an unknown Order", async () => {
		const response = await exports.default.fetch(
			`https://example.com/api/orders/by-token/${"f".repeat(64)}`,
		);

		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		expect(await response.json()).toMatchObject({ error: { code: "ORDER_NOT_FOUND" } });
	});

	it("rejects malformed lookup tokens without exposing a different error", async () => {
		const response = await exports.default.fetch(
			"https://example.com/api/orders/by-token/not-a-token",
		);

		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		expect(await response.json()).toMatchObject({ error: { code: "ORDER_NOT_FOUND" } });
	});

	it("reflects Merchant transitions while keeping the persisted ETA", async () => {
		await insertOrder("transition-order");

		const pending = await exports.default.fetch(
			`https://example.com/api/orders/by-token/${lookupToken("transition-order")}`,
		);
		await exports.default.fetch(
			"https://example.com/api/merchant/orders/transition-order/accept",
			{
				method: "POST",
				headers: { Origin: "https://example.com", "Sec-Fetch-Site": "same-origin" },
			},
		);
		const accepted = await exports.default.fetch(
			`https://example.com/api/orders/by-token/${lookupToken("transition-order")}`,
		);
		await exports.default.fetch(
			"https://example.com/api/merchant/orders/transition-order/complete",
			{
				method: "POST",
				headers: { Origin: "https://example.com", "Sec-Fetch-Site": "same-origin" },
			},
		);
		const completed = await exports.default.fetch(
			`https://example.com/api/orders/by-token/${lookupToken("transition-order")}`,
		);

		const responses = await Promise.all([pending.json(), accepted.json(), completed.json()]) as Array<{
			order: { status: string; estimatedReadyAt: string };
		}>;
		expect(responses.map((result) => result.order.status)).toEqual([
			"pending",
			"accepted",
			"completed",
		]);
		expect(responses.map((result) => result.order.estimatedReadyAt)).toEqual([
			persistedEta,
			persistedEta,
			persistedEta,
		]);
	});
});
