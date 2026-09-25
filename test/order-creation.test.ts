import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const defaultOrderRequest = {
	customerName: "王小明",
	customerPhone: "0912345678",
	specialOrder: false,
	items: [{ menuItemId: 1, quantity: 1, modifierOptionIds: [10, 20] }],
};

type OrderResponse = {
	order: {
		publicLookupToken: string;
		orderNumber: string;
		status: string;
		total: number;
		customerNote: string | null;
		packagingPreference: "together" | "separate_spicy";
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
			"INSERT INTO modifier_groups (id, menu_item_id, name, selection_type, is_required, sort_order, is_active) VALUES (1, 1, '辣度', 'single', 1, 10, 1), (2, 1, '切法', 'single', 0, 20, 1), (3, 2, '其他群組', 'single', 0, 10, 1), (4, 2, '調味', 'single', 1, 20, 1), (5, 1, '特殊選項：不加醬', 'single', 0, 30, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_options (id, modifier_group_id, name, price_delta, sort_order, is_active) VALUES (10, 1, '小辣', 5, 10, 1), (20, 2, '切', 10, 10, 1), (30, 3, '其他選項', 0, 10, 1), (40, 4, '胡椒', 0, 10, 1), (50, 5, '不加醬', 0, 10, 1), (60, 1, '辣粉另包', 0, 20, 1)",
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

async function postOrder(idempotencyKey: string, body: unknown = defaultOrderRequest) {
	let requestBody = body;
	if (body && typeof body === "object" && !Array.isArray(body)) {
		const record = body as Record<string, unknown>;
		if (!("quoteFingerprint" in record)) {
			let quoteFingerprint = "0".repeat(64);
			const quoteResponse = await postQuote(record.items);
			if (quoteResponse.ok) {
				quoteFingerprint = ((await quoteResponse.json()) as { quoteFingerprint: string })
					.quoteFingerprint;
			}
			requestBody = { ...record, quoteFingerprint };
		}
	}
	return exports.default.fetch("https://example.com/api/orders", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"Idempotency-Key": idempotencyKey,
		},
		body: JSON.stringify(requestBody),
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
	it("requires a valid confirmed quote fingerprint", async () => {
		const response = await exports.default.fetch("https://example.com/api/orders", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"Idempotency-Key": "missing-quote-fingerprint",
			},
			body: JSON.stringify(defaultOrderRequest),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "INVALID_ORDER_REQUEST" },
		});
	});

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

	it("rejects invalid Taiwan mobile numbers before creating any Order records", async () => {
		const invalidPhones: Array<[string, unknown]> = [
			["eight-digits", "09123456"],
			["letters", "09abcd5678"],
			["empty", ""],
			["blank", "   "],
			["too-short", "0912345"],
			["too-long", "09123456789"],
			["non-string", 912345678],
		];

		for (const [name, customerPhone] of invalidPhones) {
			const response = await postOrder(`phone-${name}`, {
				...defaultOrderRequest,
				customerPhone,
			});
			expect(response.status, name).toBe(400);
			expect(await response.json(), name).toMatchObject({
				error: { code: "INVALID_CUSTOMER_PHONE" },
			});
		}

		const counts = await env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM orders) AS orders_count,
				(SELECT COUNT(*) FROM order_items) AS items_count,
				(SELECT COUNT(*) FROM order_item_modifiers) AS modifiers_count,
				(SELECT COUNT(*) FROM web_push_notification_deliveries) AS notifications_count,
				(SELECT COUNT(*) FROM notification_deliveries) AS legacy_notifications_count`,
		).first();
		expect(counts).toEqual({
			orders_count: 0,
			items_count: 0,
			modifiers_count: 0,
			notifications_count: 0,
			legacy_notifications_count: 0,
		});
	});

	it("accepts an omitted note and stores null", async () => {
		const response = await postOrder("note-omitted");
		const result = (await response.json()) as OrderResponse;
		const stored = await env.DB
			.prepare("SELECT customer_note FROM orders WHERE public_lookup_token = ?")
			.bind(result.order.publicLookupToken)
			.first<{ customer_note: string | null }>();

		expect(response.status).toBe(201);
		expect(result.order.customerNote).toBeNull();
		expect(stored?.customer_note).toBeNull();
	});

	it("defaults packaging to together and persists an explicit spicy separation preference", async () => {
		const defaultResponse = await postOrder("packaging-default");
		const defaultResult = (await defaultResponse.json()) as OrderResponse;
		expect(defaultResult.order.packagingPreference).toBe("together");

		const separatedResponse = await postOrder("packaging-separated", {
			...defaultOrderRequest,
			packagingPreference: "separate_spicy",
		});
		const separated = (await separatedResponse.json()) as OrderResponse;
		const stored = await env.DB
			.prepare("SELECT packaging_preference FROM orders WHERE public_lookup_token = ?")
			.bind(separated.order.publicLookupToken)
			.first<{ packaging_preference: string }>();
		expect(separatedResponse.status).toBe(201);
		expect(separated.order.packagingPreference).toBe("separate_spicy");
		expect(stored?.packaging_preference).toBe("separate_spicy");
	});

	it("rejects invalid packaging and fingerprints packaging changes", async () => {
		const invalid = await postOrder("packaging-invalid", {
			...defaultOrderRequest,
			packagingPreference: "one-bag-per-item",
		});
		expect(invalid.status).toBe(400);

		const request = { ...defaultOrderRequest, packagingPreference: "separate_spicy" };
		const first = await postOrder("packaging-idempotency", request);
		const replay = await postOrder("packaging-idempotency", request);
		const conflict = await postOrder("packaging-idempotency", {
			...defaultOrderRequest,
			packagingPreference: "together",
		});
		expect(first.status).toBe(201);
		expect(replay.status).toBe(200);
		expect(conflict.status).toBe(409);
	});

	it("quotes and snapshots 辣粉另包 through its owned spice modifier option", async () => {
		const items = [{ menuItemId: 1, quantity: 1, modifierOptionIds: [60, 20] }];
		const quoteResponse = await postQuote(items);
		const quote = (await quoteResponse.json()) as { items: Array<{ modifiers: Array<{ optionId: number; name: string }> }> };
		expect(quoteResponse.status).toBe(200);
		expect(quote.items[0]?.modifiers).toContainEqual(expect.objectContaining({ optionId: 60, name: "辣粉另包" }));

		const orderResponse = await postOrder("pepper-packet-line", { ...defaultOrderRequest, items });
		const order = (await orderResponse.json()) as OrderResponse;
		expect(orderResponse.status).toBe(201);
		expect(order.order.items[0]?.modifiers).toContainEqual({
			groupName: "辣度",
			name: "辣粉另包",
			priceDelta: 0,
		});
	});

	it("normalizes a blank note to null", async () => {
		const response = await postOrder("note-blank", { ...defaultOrderRequest, customerNote: "   " });
		const result = (await response.json()) as OrderResponse;

		expect(response.status).toBe(201);
		expect(result.order.customerNote).toBeNull();
	});

	it("trims and persists a valid Chinese note", async () => {
		const response = await postOrder("note-chinese", {
			...defaultOrderRequest,
			customerNote: "  雞排不要切、辣粉另包  ",
		});
		const result = (await response.json()) as OrderResponse;
		const stored = await env.DB
			.prepare("SELECT customer_note FROM orders WHERE public_lookup_token = ?")
			.bind(result.order.publicLookupToken)
			.first<{ customer_note: string | null }>();

		expect(response.status).toBe(201);
		expect(result.order.customerNote).toBe("雞排不要切、辣粉另包");
		expect(stored?.customer_note).toBe("雞排不要切、辣粉另包");
	});

	it("stores SQL- and HTML-shaped note content as inert bound text", async () => {
		const customerNote = "'); DROP TABLE orders; -- <script>alert(1)</script>";
		const response = await postOrder("note-inert-text", { ...defaultOrderRequest, customerNote });
		const result = (await response.json()) as OrderResponse;
		const stored = await env.DB.prepare(
			"SELECT customer_note AS customerNote FROM orders WHERE public_lookup_token = ?",
		).bind(result.order.publicLookupToken).first<{ customerNote: string | null }>();
		const tableStillExists = await env.DB.prepare("SELECT COUNT(*) AS count FROM orders").first<{ count: number }>();

		expect(response.status).toBe(201);
		expect(stored?.customerNote).toBe(customerNote);
		expect(tableStillExists?.count).toBe(1);
	});

	it("accepts exactly 120 Unicode characters", async () => {
		const customerNote = "🍟".repeat(120);
		const response = await postOrder("note-120", { ...defaultOrderRequest, customerNote });
		const result = (await response.json()) as OrderResponse;

		expect(response.status).toBe(201);
		expect(result.order.customerNote).toBe(customerNote);
	});

	it("rejects a note over 120 Unicode characters", async () => {
		const response = await postOrder("note-121", {
			...defaultOrderRequest,
			customerNote: "🍟".repeat(121),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "INVALID_ORDER_REQUEST" } });
	});

	it("rejects a non-string note", async () => {
		const response = await postOrder("note-number", {
			...defaultOrderRequest,
			customerNote: 123,
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "INVALID_ORDER_REQUEST" } });
	});

	it("accepts reasonable line breaks in a note", async () => {
		const response = await postOrder("note-control", {
			...defaultOrderRequest,
			customerNote: "雞排不要切\n辣粉另包",
		});
		const result = await response.json() as OrderResponse;

		expect(response.status).toBe(201);
		expect(result.order.customerNote).toBe("雞排不要切\n辣粉另包");
	});

	it("rejects non-line-break control characters in a note", async () => {
		const response = await postOrder("note-tab-control", {
			...defaultOrderRequest,
			customerNote: "雞排不要切\t辣粉另包",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "INVALID_ORDER_REQUEST" } });
	});

	it("preserves item and modifier snapshots after menu changes", async () => {
		const snapshotRequest = { ...defaultOrderRequest, customerNote: "雞排不要切" };
		const firstResponse = await postOrder("snapshot-key", snapshotRequest);
		const first = (await firstResponse.json()) as OrderResponse;

		await env.DB.batch([
			env.DB.prepare("UPDATE menu_items SET name = '豪大雞排', price = 95 WHERE id = 1"),
			env.DB.prepare("UPDATE modifier_groups SET name = '辣度新版' WHERE id = 1"),
			env.DB.prepare("UPDATE modifier_options SET name = '微辣', price_delta = 20 WHERE id = 10"),
		]);

		const retryResponse = await postOrder("snapshot-key", snapshotRequest);
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
		expect(retry.order.customerNote).toBe("雞排不要切");
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
			error: {
				code: "UNAVAILABLE_ITEM",
				lineIssues: [{ itemIndex: 0, menuItemId: 1, code: "UNAVAILABLE_ITEM" }],
			},
		});
		const counts = await env.DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM orders) AS orders_count,
				(SELECT COUNT(*) FROM order_items) AS items_count,
				(SELECT COUNT(*) FROM web_push_notification_deliveries) AS notifications_count`,
		).first();
		expect(counts).toEqual({ orders_count: 0, items_count: 0, notifications_count: 0 });
	});

	it("rejects an unconfirmed price change, leaves no children, and accepts the refreshed quote with the same key", async () => {
		const quoteResponse = await postQuote();
		const quote = (await quoteResponse.json()) as { total: number; quoteFingerprint: string };
		expect(quoteResponse.status).toBe(200);
		expect(quote.total).toBe(100);

		await env.DB.prepare("UPDATE menu_items SET price = 95 WHERE id = 1").run();
		const orderResponse = await postOrder("price-changed-after-quote", {
			...defaultOrderRequest,
			quoteFingerprint: quote.quoteFingerprint,
		});

		expect(orderResponse.status).toBe(409);
		expect(await orderResponse.json()).toMatchObject({ error: { code: "QUOTE_CHANGED" } });
		const countsAfterReject = await env.DB
			.prepare(
				`SELECT
					(SELECT COUNT(*) FROM orders) AS orders_count,
					(SELECT COUNT(*) FROM order_items) AS items_count,
					(SELECT COUNT(*) FROM order_item_modifiers) AS modifiers_count,
					(SELECT COUNT(*) FROM web_push_notification_deliveries) AS notifications_count,
					(SELECT COUNT(*) FROM notification_deliveries) AS legacy_notifications_count`,
			)
			.first();
		expect(countsAfterReject).toEqual({
			orders_count: 0,
			items_count: 0,
			modifiers_count: 0,
			notifications_count: 0,
			legacy_notifications_count: 0,
		});

		const refreshedQuoteResponse = await postQuote();
		const refreshedQuote = (await refreshedQuoteResponse.json()) as {
			total: number;
			quoteFingerprint: string;
		};
		expect(refreshedQuote).toMatchObject({ total: 110 });
		const confirmedResponse = await postOrder("price-changed-after-quote", {
			...defaultOrderRequest,
			quoteFingerprint: refreshedQuote.quoteFingerprint,
		});
		const confirmed = (await confirmedResponse.json()) as OrderResponse;
		expect(confirmedResponse.status).toBe(201);
		expect(confirmed.order).toMatchObject({
			total: 110,
			items: [{ unitPrice: 110, lineTotal: 110 }],
		});
	});

	it("rejects an unconfirmed modifier-price change", async () => {
		const quoteResponse = await postQuote();
		const quote = (await quoteResponse.json()) as { quoteFingerprint: string };
		await env.DB.prepare("UPDATE modifier_options SET price_delta = 15 WHERE id = 10").run();

		const response = await postOrder("modifier-price-changed", {
			...defaultOrderRequest,
			quoteFingerprint: quote.quoteFingerprint,
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: { code: "QUOTE_CHANGED" } });
		expect(
			(await env.DB.prepare("SELECT COUNT(*) AS count FROM orders").first<{ count: number }>())
				?.count,
		).toBe(0);
	});

	it("detects offsetting base and modifier price changes even when the total is unchanged", async () => {
		const quoteResponse = await postQuote();
		const quote = (await quoteResponse.json()) as { total: number; quoteFingerprint: string };
		expect(quote.total).toBe(100);
		await env.DB.batch([
			env.DB.prepare("UPDATE menu_items SET price = 90 WHERE id = 1"),
			env.DB.prepare("UPDATE modifier_options SET price_delta = 0 WHERE id = 10"),
		]);
		const currentQuote = (await (await postQuote()).json()) as { total: number };
		expect(currentQuote.total).toBe(100);

		const response = await postOrder("offsetting-price-change", {
			...defaultOrderRequest,
			quoteFingerprint: quote.quoteFingerprint,
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: { code: "QUOTE_CHANGED" } });
		expect(
			(await env.DB.prepare("SELECT COUNT(*) AS count FROM orders").first<{ count: number }>())
				?.count,
		).toBe(0);
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

	it("rejects a seasoning option owned by another menu item", async () => {
		const response = await postOrder("invalid-modifier", {
			...defaultOrderRequest,
			items: [{ menuItemId: 1, quantity: 1, modifierOptionIds: [10, 40] }],
		});

		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({
			error: { code: "INVALID_MODIFIER_OPTION" },
		});
	});

	it("accepts API-backed Special Options through the existing modifier snapshot path", async () => {
		const response = await postOrder("special-option", {
			...defaultOrderRequest,
			items: [{ menuItemId: 1, quantity: 1, modifierOptionIds: [10, 20, 50] }],
		});
		const result = (await response.json()) as OrderResponse;

		expect(response.status).toBe(201);
		expect(result.order.items[0]?.modifiers).toContainEqual({
			groupName: "特殊選項：不加醬",
			name: "不加醬",
			priceDelta: 0,
		});
	});

	it("returns the same Order for an identical idempotent retry", async () => {
		const request = { ...defaultOrderRequest, customerNote: "辣粉另包" };
		const firstResponse = await postOrder("same-request-key", request);
		const secondResponse = await postOrder("same-request-key", request);
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

	it("rejects the same idempotency key with a different note", async () => {
		await postOrder("note-conflict-key", { ...defaultOrderRequest, customerNote: "辣粉另包" });
		const response = await postOrder("note-conflict-key", {
			...defaultOrderRequest,
			customerNote: "不要辣粉",
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: { code: "IDEMPOTENCY_KEY_CONFLICT" },
		});
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
		const readyDelay = Date.parse(result.order.estimatedReadyAt) - Date.parse(result.order.createdAt);
		expect(readyDelay).toBeGreaterThanOrEqual(40 * 60_000);
		expect(readyDelay).toBeLessThan(45 * 60_000);
		expect(new Date(result.order.estimatedReadyAt).getUTCMinutes() % 5).toBe(0);
		expect(activeCount?.count).toBe(3);
	});
});
