import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const items = [{ menuItemId: 771, quantity: 1, modifierOptionIds: [] }];

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (771, '現場測試', 771, 1)",
		),
		env.DB.prepare(
			"INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (771, 771, '現場雞排', '', 85, 771, 1)",
		),
	]);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM order_item_modifiers"),
		env.DB.prepare("DELETE FROM order_items"),
		env.DB.prepare("DELETE FROM orders"),
		env.DB.prepare("UPDATE menu_items SET is_available = 1, price = 85 WHERE id = 771"),
		env.DB.prepare("UPDATE store_settings SET is_accepting_orders = 1 WHERE id = 1"),
	]);
});

async function quote() {
	const response = await exports.default.fetch("https://example.com/api/checkout/quote", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ items }),
	});
	expect(response.status).toBe(200);
	return response.json() as Promise<{ quoteFingerprint: string; total: number }>;
}

async function postOnsite(idempotencyKey: string, body: Record<string, unknown>) {
	return exports.default.fetch("https://example.com/api/onsite/orders", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"Idempotency-Key": idempotencyKey,
		},
		body: JSON.stringify(body),
	});
}

describe("POST /api/onsite/orders", () => {
	it("creates an onsite order without customer name or phone using authoritative pricing", async () => {
		const confirmed = await quote();
		const response = await postOnsite("onsite-create", {
			specialOrder: false,
			quoteFingerprint: confirmed.quoteFingerprint,
			items,
		});
		const result = await response.json() as {
			order: { publicLookupToken: string; orderSource: string; total: number };
		};
		expect(response.status).toBe(201);
		expect(result.order).toMatchObject({ orderSource: "onsite", total: 85 });
		const stored = await env.DB.prepare(
			"SELECT order_source, customer_name, customer_phone, total_amount FROM orders WHERE public_lookup_token = ?",
		).bind(result.order.publicLookupToken).first();
		expect(stored).toEqual({
			order_source: "onsite",
			customer_name: "現場顧客",
			customer_phone: "現場免填",
			total_amount: 85,
		});

		const lookup = await exports.default.fetch(
			`https://example.com/api/orders/by-token/${result.order.publicLookupToken}`,
		);
		expect(lookup.status).toBe(200);
		expect(await lookup.json()).toMatchObject({ order: { orderSource: "onsite", total: 85 } });
	});

	it("does not let a client inject source or contact fields into the onsite contract", async () => {
		const confirmed = await quote();
		for (const extra of [
			{ orderSource: "online" },
			{ customerName: "遠端顧客" },
			{ customerPhone: "0912345678" },
		]) {
			const response = await postOnsite(`onsite-extra-${Object.keys(extra)[0]}`, {
				specialOrder: false,
				quoteFingerprint: confirmed.quoteFingerprint,
				items,
				...extra,
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				error: { code: "INVALID_ORDER_REQUEST" },
			});
		}
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM orders").first()).toEqual({ count: 0 });
	});

	it("keeps the online contact contract unchanged", async () => {
		const confirmed = await quote();
		const response = await exports.default.fetch("https://example.com/api/orders", {
			method: "POST",
			headers: { "content-type": "application/json", "Idempotency-Key": "online-no-contact" },
			body: JSON.stringify({
				specialOrder: false,
				quoteFingerprint: confirmed.quoteFingerprint,
				items,
			}),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "INVALID_CUSTOMER_PHONE" } });
	});

	it("uses the existing store pause and sold-out validation", async () => {
		const confirmed = await quote();
		await env.DB.prepare("UPDATE store_settings SET is_accepting_orders = 0 WHERE id = 1").run();
		const paused = await postOnsite("onsite-paused", {
			specialOrder: false,
			quoteFingerprint: confirmed.quoteFingerprint,
			items,
		});
		expect(paused.status).toBe(409);
		expect(await paused.json()).toMatchObject({ error: { code: "STORE_NOT_ACCEPTING_ORDERS" } });

		await env.DB.batch([
			env.DB.prepare("UPDATE store_settings SET is_accepting_orders = 1 WHERE id = 1"),
			env.DB.prepare("UPDATE menu_items SET is_available = 0 WHERE id = 771"),
		]);
		const unavailable = await postOnsite("onsite-unavailable", {
			specialOrder: false,
			quoteFingerprint: confirmed.quoteFingerprint,
			items,
		});
		expect(unavailable.status).toBe(422);
		expect(await unavailable.json()).toMatchObject({ error: { code: "UNAVAILABLE_ITEM" } });
	});

	it("replays the same onsite request and conflicts with a different source", async () => {
		const confirmed = await quote();
		const body = {
			specialOrder: false,
			quoteFingerprint: confirmed.quoteFingerprint,
			items,
		};
		const first = await postOnsite("onsite-replay", body);
		const replay = await postOnsite("onsite-replay", body);
		expect(first.status).toBe(201);
		expect(replay.status).toBe(200);
		expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM orders").first()).toEqual({ count: 1 });

		const online = await exports.default.fetch("https://example.com/api/orders", {
			method: "POST",
			headers: { "content-type": "application/json", "Idempotency-Key": "onsite-replay" },
			body: JSON.stringify({
				...body,
				customerName: "王小明",
				customerPhone: "0912345678",
			}),
		});
		expect(online.status).toBe(409);
		expect(await online.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_CONFLICT" } });
	});

	it("prevents concurrent onsite orders from reserving the same deadline", async () => {
		const confirmed = await quote();
		const body = {
			specialOrder: false,
			quoteFingerprint: confirmed.quoteFingerprint,
			items,
		};
		const responses = await Promise.all([
			postOnsite("onsite-concurrent-a", body),
			postOnsite("onsite-concurrent-b", body),
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([201, 201]);
		const { results } = await env.DB.prepare(
			"SELECT estimated_ready_at AS estimatedReadyAt FROM orders ORDER BY estimated_ready_at",
		).all<{ estimatedReadyAt: string }>();
		expect(results).toHaveLength(2);
		expect(new Set(results.map((row) => row.estimatedReadyAt)).size).toBe(2);
	});
});
