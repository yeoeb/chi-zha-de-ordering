import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const defaultOrderRequest = {
	customerName: "王小明",
	customerPhone: "0912-345-678",
	specialOrder: false,
	items: [{ menuItemId: 1, quantity: 1, modifierOptionIds: [10, 20] }],
};

type OrderResponse = {
	order: {
		publicLookupToken: string;
		orderNumber: string;
		status: string;
		total: number;
		estimatedReadyAt: string;
		createdAt: string;
		items: Array<{
			name: string;
			unitPrice: number;
			lineTotal: number;
			modifiers: Array<{ groupName: string; name: string; priceDelta: number }>;
		}>;
	};
};

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (1, '啟用分類', 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (1, 1, '雞排', '', 85, 10, 1), (2, 1, '其他品項', '', 40, 20, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_groups (id, menu_item_id, name, selection_type, is_required, sort_order, is_active) VALUES (1, 1, '辣度', 'single', 1, 10, 1), (2, 1, '切法', 'single', 0, 20, 1), (3, 2, '其他群組', 'single', 0, 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_options (id, modifier_group_id, name, price_delta, sort_order, is_active) VALUES (10, 1, '小辣', 5, 10, 1), (20, 2, '切', 10, 10, 1), (30, 3, '其他選項', 0, 10, 1)",
		),
	]);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM order_item_modifiers"),
		env.DB.prepare("DELETE FROM order_items"),
		env.DB.prepare("DELETE FROM orders"),
		env.DB.prepare("UPDATE menu_items SET name = '雞排', price = 85, is_available = 1 WHERE id = 1"),
		env.DB.prepare("UPDATE modifier_groups SET name = '辣度', is_active = 1 WHERE id = 1"),
		env.DB.prepare("UPDATE modifier_options SET name = '小辣', price_delta = 5, is_active = 1 WHERE id = 10"),
	]);
});

function postOrder(idempotencyKey: string, body: unknown = defaultOrderRequest) {
	return exports.default.fetch("https://example.com/api/orders", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"Idempotency-Key": idempotencyKey,
		},
		body: JSON.stringify(body),
	});
}

function postQuote(items: unknown = defaultOrderRequest.items) {
	return exports.default.fetch("https://example.com/api/checkout/quote", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ items }),
	});
}

async function insertQueueOrder(
	id: string,
	status: "pending" | "accepted" | "completed" | "rejected",
	specialOrder: boolean,
) {
	await env.DB
		.prepare(
			`INSERT INTO orders (
				id, public_lookup_token, order_number, status, total_amount, estimated_ready_at, created_at,
				customer_name, customer_phone, special_order, idempotency_key, request_fingerprint
			) VALUES (?, ?, ?, ?, 0, '2026-09-06T04:15:00.000Z', '2026-09-06T04:00:00.000Z', 'Queue', '0900000000', ?, ?, ?)`,
		)
		.bind(
			id,
			Array.from({ length: 64 }, (_, index) =>
				((id.charCodeAt(index % id.length) + index) % 16).toString(16),
			).join(""),
			`QUEUE-${id}`,
			status,
			specialOrder ? 1 : 0,
			`queue-key-${id}`,
			"a".repeat(64),
		)
		.run();
}

describe("POST /api/orders", () => {
	it("creates a pending Order from current authoritative prices", async () => {
		const response = await postOrder("create-current-price");
		const result = (await response.json()) as OrderResponse;

		expect(response.status).toBe(201);
		expect(result.order).toMatchObject({
			status: "pending",
			total: 100,
			items: [{ name: "雞排", unitPrice: 100, lineTotal: 100 }],
		});
		const stored = await env.DB
			.prepare("SELECT status, total_amount FROM orders WHERE public_lookup_token = ?")
			.bind(result.order.publicLookupToken)
			.first<{ status: string; total_amount: number }>();
		expect(stored).toEqual({ status: "pending", total_amount: 100 });
	});

	it("preserves item and modifier snapshots after menu changes", async () => {
		const firstResponse = await postOrder("snapshot-key");
		const first = (await firstResponse.json()) as OrderResponse;

		await env.DB.batch([
			env.DB.prepare("UPDATE menu_items SET name = '豪大雞排', price = 95 WHERE id = 1"),
			env.DB.prepare("UPDATE modifier_groups SET name = '辣度新版' WHERE id = 1"),
			env.DB.prepare("UPDATE modifier_options SET name = '微辣', price_delta = 20 WHERE id = 10"),
		]);

		const retryResponse = await postOrder("snapshot-key");
		const retry = (await retryResponse.json()) as OrderResponse;

		expect(retryResponse.status).toBe(200);
		expect(retry.order.publicLookupToken).toBe(first.order.publicLookupToken);
		expect(retry.order.items[0]).toMatchObject({
			name: "雞排",
			unitPrice: 100,
			modifiers: [
				{ groupName: "辣度", name: "小辣", priceDelta: 5 },
				{ groupName: "切法", name: "切", priceDelta: 10 },
			],
		});
	});

	it("rejects client price fields", async () => {
		const response = await postOrder("client-price-key", {
			...defaultOrderRequest,
			total: 1,
			items: [{ ...defaultOrderRequest.items[0], price: 1, lineTotal: 1 }],
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "INVALID_ORDER_REQUEST" },
		});
	});

	it("revalidates availability after a successful quote", async () => {
		const quoteResponse = await postQuote();
		expect(quoteResponse.status).toBe(200);

		await env.DB.prepare("UPDATE menu_items SET is_available = 0 WHERE id = 1").run();
		const orderResponse = await postOrder("sold-out-after-quote");

		expect(orderResponse.status).toBe(422);
		expect(await orderResponse.json()).toMatchObject({
			error: { code: "UNAVAILABLE_ITEM" },
		});
	});

	it("reprices from current D1 data after a successful quote", async () => {
		const quoteResponse = await postQuote();
		const quote = (await quoteResponse.json()) as { total: number };
		expect(quoteResponse.status).toBe(200);
		expect(quote.total).toBe(100);

		await env.DB.prepare("UPDATE menu_items SET price = 95 WHERE id = 1").run();
		const orderResponse = await postOrder("price-changed-after-quote");
		const order = (await orderResponse.json()) as OrderResponse;

		expect(orderResponse.status).toBe(201);
		expect(order.order).toMatchObject({
			total: 110,
			items: [{ unitPrice: 110, lineTotal: 110 }],
		});
	});

	it("rejects a modifier that becomes inactive after a successful quote", async () => {
		const quoteResponse = await postQuote();
		expect(quoteResponse.status).toBe(200);

		await env.DB.prepare("UPDATE modifier_options SET is_active = 0 WHERE id = 10").run();
		const orderResponse = await postOrder("modifier-inactive-after-quote");

		expect(orderResponse.status).toBe(422);
		expect(await orderResponse.json()).toMatchObject({
			error: { code: "INACTIVE_MODIFIER_OPTION" },
		});
	});

	it("rejects an invalid modifier at Order creation", async () => {
		const response = await postOrder("invalid-modifier", {
			...defaultOrderRequest,
			items: [{ menuItemId: 1, quantity: 1, modifierOptionIds: [10, 30] }],
		});

		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			error: { code: "INVALID_MODIFIER_OPTION" },
		});
	});

	it("returns the same Order for an identical idempotent retry", async () => {
		const firstResponse = await postOrder("same-request-key");
		const secondResponse = await postOrder("same-request-key");
		const first = (await firstResponse.json()) as OrderResponse;
		const second = (await secondResponse.json()) as OrderResponse;
		const count = await env.DB
			.prepare("SELECT COUNT(*) AS count FROM orders WHERE idempotency_key = ?")
			.bind("same-request-key")
			.first<{ count: number }>();

		expect(firstResponse.status).toBe(201);
		expect(secondResponse.status).toBe(200);
		expect(second.order).toEqual(first.order);
		expect(second.order.publicLookupToken).toBe(first.order.publicLookupToken);
		expect(count?.count).toBe(1);
	});

	it("rejects conflicting reuse of an idempotency key", async () => {
		await postOrder("conflict-key");
		const response = await postOrder("conflict-key", {
			...defaultOrderRequest,
			items: [{ ...defaultOrderRequest.items[0], quantity: 2 }],
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: { code: "IDEMPOTENCY_KEY_CONFLICT" },
		});
	});

	it("backs idempotency with a database uniqueness constraint", async () => {
		await postOrder("db-unique-key");

		await expect(
			env.DB
				.prepare(
					`INSERT INTO orders (
							id, public_lookup_token, order_number, status, total_amount, estimated_ready_at, created_at,
						customer_name, customer_phone, special_order, idempotency_key, request_fingerprint
						) VALUES ('duplicate-id', ?, 'DUPLICATE-NUMBER', 'pending', 0, ?, ?, 'Test', '0900000000', 0, 'db-unique-key', ?)`,
				)
					.bind(
						"d".repeat(64),
						"2026-09-06T04:15:00.000Z",
					"2026-09-06T04:00:00.000Z",
					"b".repeat(64),
				)
				.run(),
		).rejects.toThrow(/UNIQUE constraint failed: orders\.idempotency_key/);
	});

	it("counts pending and accepted queue Orders, excludes terminal Orders, and excludes itself", async () => {
		await insertQueueOrder("pending-normal", "pending", false);
		await insertQueueOrder("accepted-special", "accepted", true);
		await insertQueueOrder("completed-special", "completed", true);
		await insertQueueOrder("rejected-special", "rejected", true);

		const response = await postOrder("queue-aware-key");
		const result = (await response.json()) as OrderResponse;
		const activeCount = await env.DB
			.prepare("SELECT COUNT(*) AS count FROM orders WHERE status IN ('pending', 'accepted')")
			.first<{ count: number }>();

		expect(response.status).toBe(201);
		expect(Date.parse(result.order.estimatedReadyAt) - Date.parse(result.order.createdAt)).toBe(
			35 * 60_000,
		);
		expect(activeCount?.count).toBe(3);
	});
});
