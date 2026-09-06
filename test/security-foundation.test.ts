import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/worker/index";
import { MAX_PUBLIC_REQUEST_BODY_BYTES } from "../src/worker/request-body";
import {
	isMerchantRequestAllowed,
	isRateLimitAllowed,
	type SecurityBindings,
} from "../src/worker/security";

const orderRequest = {
	customerName: "王小明",
	customerPhone: "0912345678",
	specialOrder: false,
	items: [{ menuItemId: 1, quantity: 1, modifierOptionIds: [] }],
};

type CreatedOrder = {
	order: {
		publicLookupToken: string;
		orderNumber: string;
		status: string;
		total: number;
	};
};

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (1, '人氣', 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (1, 1, '雞排', '', 85, 10, 1)",
		),
	]);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM order_item_modifiers"),
		env.DB.prepare("DELETE FROM order_items"),
		env.DB.prepare("DELETE FROM orders"),
	]);
});

function postOrder(idempotencyKey: string, body: unknown = orderRequest) {
	return exports.default.fetch("https://example.com/api/orders", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"Idempotency-Key": idempotencyKey,
		},
		body: JSON.stringify(body),
	});
}

describe("public Order lookup tokens", () => {
	it("creates unique 256-bit tokens and reads Orders only through the public token contract", async () => {
		const firstResponse = await postOrder("security-token-one");
		const secondResponse = await postOrder("security-token-two");
		const first = (await firstResponse.json()) as CreatedOrder;
		const second = (await secondResponse.json()) as CreatedOrder;

		expect(firstResponse.status).toBe(201);
		expect(first.order).not.toHaveProperty("id");
		expect(first.order.publicLookupToken).toMatch(/^[0-9a-f]{64}$/);
		expect(second.order.publicLookupToken).toMatch(/^[0-9a-f]{64}$/);
		expect(second.order.publicLookupToken).not.toBe(first.order.publicLookupToken);

		const publicRead = await exports.default.fetch(
			`https://example.com/api/orders/by-token/${first.order.publicLookupToken}`,
		);
		const publicResult = (await publicRead.json()) as { order: Record<string, unknown> };
		const stored = await env.DB
			.prepare("SELECT id FROM orders WHERE public_lookup_token = ?")
			.bind(first.order.publicLookupToken)
			.first<{ id: string }>();
		const internalRead = await exports.default.fetch(
			`https://example.com/api/orders/${stored?.id}`,
		);

		expect(publicRead.status).toBe(200);
		expect(publicRead.headers.get("Cache-Control")).toContain("no-store");
		expect(publicResult.order).toMatchObject({
			publicLookupToken: first.order.publicLookupToken,
			orderNumber: first.order.orderNumber,
			status: "pending",
			total: 85,
		});
		expect(publicResult.order).not.toHaveProperty("id");
		expect(publicResult.order).not.toHaveProperty("customerPhone");
		expect(internalRead.status).toBe(404);
	});

	it("does not accept a client-selected public lookup token", async () => {
		const chosenToken = "a".repeat(64);
		const response = await postOrder("client-token-rejected", {
			...orderRequest,
			publicLookupToken: chosenToken,
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "INVALID_ORDER_REQUEST" },
		});
		const stored = await env.DB
			.prepare("SELECT id FROM orders WHERE public_lookup_token = ?")
			.bind(chosenToken)
			.first();
		expect(stored).toBeNull();
	});

	it("returns no-store 404 for an unknown token", async () => {
		const response = await exports.default.fetch(
			`https://example.com/api/orders/by-token/${"f".repeat(64)}`,
		);

		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		expect(await response.json()).toMatchObject({ error: { code: "ORDER_NOT_FOUND" } });
	});

	it("backs token uniqueness and immutability with D1 constraints", async () => {
		const createdResponse = await postOrder("token-constraint");
		const created = (await createdResponse.json()) as CreatedOrder;
		const stored = await env.DB
			.prepare("SELECT id FROM orders WHERE public_lookup_token = ?")
			.bind(created.order.publicLookupToken)
			.first<{ id: string }>();

		await expect(
			env.DB
				.prepare(
					`INSERT INTO orders (
						id, public_lookup_token, order_number, status, total_amount,
						estimated_ready_at, created_at, customer_name, customer_phone,
						special_order, idempotency_key, request_fingerprint
					) VALUES ('duplicate-token-order', ?, 'DUPLICATE-TOKEN', 'pending', 0,
						'2026-09-07T01:00:00.000Z', '2026-09-07T00:00:00.000Z',
						'Test', '0900000000', 0, 'duplicate-token-key', ?)`,
				)
				.bind(created.order.publicLookupToken, "a".repeat(64))
				.run(),
		).rejects.toThrow(/UNIQUE constraint failed: orders\.public_lookup_token/);

		await expect(
			env.DB
				.prepare("UPDATE orders SET public_lookup_token = ? WHERE id = ?")
				.bind("b".repeat(64), stored?.id)
				.run(),
		).rejects.toThrow(/public lookup token is immutable/);
	});
});

describe("Merchant access boundary", () => {
	it("fails closed without a Cloudflare Access token in production", async () => {
		const response = await app.request(
			new Request("https://merchant.example.com/api/merchant/orders"),
			undefined,
			{
				DB: env.DB,
				ORDER_RATE_LIMITER: env.ORDER_RATE_LIMITER,
				MERCHANT_HOSTNAME: "merchant.example.com",
			} as Env & SecurityBindings,
			{} as ExecutionContext,
		);

		expect(response.status).toBe(403);
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		expect(await response.json()).toMatchObject({
			error: { code: "MERCHANT_ACCESS_DENIED" },
		});
	});

	it("allows only a valid Access token on the configured hostname", async () => {
		const verifyAccessToken = async (token: string, teamDomain: string, audience: string) =>
			token === "signed-token" &&
			teamDomain === "https://team.cloudflareaccess.com" &&
			audience === "merchant-aud";

		await expect(
			isMerchantRequestAllowed({
				expectedHostname: "merchant.example.com",
				requestUrl: "https://merchant.example.com/api/merchant/orders",
				accessAudience: "merchant-aud",
				accessTeamDomain: "https://team.cloudflareaccess.com",
				accessToken: "signed-token",
				verifyAccessToken,
			}),
		).resolves.toBe(true);
		await expect(
			isMerchantRequestAllowed({
				expectedHostname: "merchant.example.com",
				requestUrl: "https://chi-zha-de-ordering.workers.dev/api/merchant/orders",
				accessAudience: "merchant-aud",
				accessTeamDomain: "https://team.cloudflareaccess.com",
				accessToken: "signed-token",
				verifyAccessToken,
			}),
		).resolves.toBe(false);
	});

	it("keeps the explicit development bypass local to its binding", async () => {
		await expect(
			isMerchantRequestAllowed({
				devBypass: "true",
				requestUrl: "http://localhost/api/merchant/orders",
			}),
		).resolves.toBe(true);

		const merchantResponse = await exports.default.fetch(
			"https://example.com/api/merchant/orders",
		);
		const customerResponse = await exports.default.fetch("https://example.com/api/menu");
		expect(merchantResponse.status).toBe(200);
		expect(merchantResponse.headers.get("Cache-Control")).toContain("no-store");
		expect(customerResponse.status).toBe(200);
	});
});

describe("public write boundaries", () => {
	it("returns 429 when the Order rate limiter rejects a request", async () => {
		const limiter = { limit: async () => ({ success: false }) } as RateLimit;
		const response = await app.request(
			new Request("https://example.com/api/orders", {
				method: "POST",
				headers: {
					"CF-Connecting-IP": "192.0.2.10",
					"content-type": "application/json",
					"Idempotency-Key": "rate-limited",
				},
				body: JSON.stringify(orderRequest),
			}),
			undefined,
			{
				DB: env.DB,
				MERCHANT_DEV_BYPASS: "true",
				ORDER_RATE_LIMITER: limiter,
			} as Env & SecurityBindings,
			{} as ExecutionContext,
		);

		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("60");
		expect(await response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
	});

	it("lets an allowed limiter result proceed to normal request validation", async () => {
		const limiter = { limit: async () => ({ success: true }) } as RateLimit;
		await expect(isRateLimitAllowed(limiter, "create-order:test")).resolves.toBe(true);

		const response = await app.request(
			new Request("https://example.com/api/orders", {
				method: "POST",
				headers: {
					"CF-Connecting-IP": "192.0.2.11",
					"content-type": "application/json",
					"Idempotency-Key": "allowed-invalid-body",
				},
				body: "not-json",
			}),
			undefined,
			{
				DB: env.DB,
				MERCHANT_DEV_BYPASS: "true",
				ORDER_RATE_LIMITER: limiter,
			} as Env & SecurityBindings,
			{} as ExecutionContext,
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "INVALID_ORDER_REQUEST" },
		});
	});

	it("rejects a non-JSON media type clearly", async () => {
		const response = await exports.default.fetch("https://example.com/api/checkout/quote", {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: JSON.stringify({ items: [] }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
	});

	it("rejects oversized bodies and bounded field violations", async () => {
		const oversized = await exports.default.fetch("https://example.com/api/orders", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"Idempotency-Key": "oversized-body",
			},
			body: JSON.stringify({ padding: "x".repeat(MAX_PUBLIC_REQUEST_BODY_BYTES) }),
		});
		const tooManyLines = await postOrder("too-many-lines", {
			...orderRequest,
			items: Array.from({ length: 51 }, () => orderRequest.items[0]),
		});
		const invalidQuantity = await postOrder("invalid-quantity", {
			...orderRequest,
			items: [{ ...orderRequest.items[0], quantity: 0 }],
		});
		const longName = await postOrder("long-name", {
			...orderRequest,
			customerName: "x".repeat(51),
		});
		const longPhone = await postOrder("long-phone", {
			...orderRequest,
			customerPhone: "1".repeat(31),
		});

		expect(oversized.status).toBe(413);
		expect(await oversized.json()).toMatchObject({
			error: { code: "REQUEST_BODY_TOO_LARGE" },
		});
		expect(tooManyLines.status).toBe(400);
		expect(invalidQuantity.status).toBe(422);
		expect(longName.status).toBe(400);
		expect(longPhone.status).toBe(400);
	});
});
