import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/worker/index";
import { MAX_PUBLIC_REQUEST_BODY_BYTES } from "../src/worker/request-body";
import {
	authenticateMerchantRequest,
	isMerchantRequestAllowed,
	isMerchantMutationRequestAllowed,
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
			error: { code: "AUTH_DENIED" },
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

	it("returns only an opaque verified Access subject for audit hashing", async () => {
		await expect(
			authenticateMerchantRequest({
				expectedHostname: "merchant.example.com",
				requestUrl: "https://merchant.example.com/api/merchant/orders",
				accessAudience: "merchant-aud",
				accessTeamDomain: "https://team.cloudflareaccess.com",
				accessToken: "signed-token",
				verifyAccessIdentity: async () => ({ subject: "opaque-subject" }),
			}),
		).resolves.toEqual({ subject: "opaque-subject" });
	});
});

describe("Merchant mutation origin boundary", () => {
	const body = JSON.stringify({
		operationId: "00000000-0000-4000-8000-000000000100",
		expectedIsAcceptingOrders: false,
		expectedStateVersion: 0,
	});
	const merchantMutationRoutes = [
		{
			method: "POST",
			path: "/api/merchant/push/subscriptions",
			body: {
				endpoint: "https://push.example.test/csrf-guard",
				keys: { p256dh: "test-p256dh", auth: "test-auth" },
			},
		},
		{
			method: "DELETE",
			path: "/api/merchant/push/subscriptions",
			body: { endpoint: "https://push.example.test/csrf-guard" },
		},
		{ method: "POST", path: "/api/merchant/notifications/missing/retry", body: {} },
		{ method: "POST", path: "/api/merchant/menu-items/1/sold-out", body: {} },
		{ method: "POST", path: "/api/merchant/menu-items/1/restore", body: {} },
		{
			method: "POST",
			path: "/api/merchant/store/pause",
			body: {
				operationId: "00000000-0000-4000-8000-000000000101",
				expectedIsAcceptingOrders: true,
				expectedStateVersion: 0,
			},
		},
		{
			method: "POST",
			path: "/api/merchant/store/resume",
			body: JSON.parse(body),
		},
		{ method: "POST", path: "/api/merchant/orders/missing/accept", body: {} },
		{ method: "POST", path: "/api/merchant/orders/missing/reject", body: {} },
		{ method: "POST", path: "/api/merchant/orders/missing/complete", body: {} },
	] as const;

	async function merchantMutationSnapshot() {
		return env.DB.prepare(
			`SELECT
				(SELECT is_accepting_orders FROM store_settings WHERE id = 1) AS accepting,
				(SELECT state_version FROM store_settings WHERE id = 1) AS stateVersion,
				(SELECT COUNT(*) FROM store_state_events) AS storeEventCount,
				(SELECT group_concat(id || ':' || is_available, ',') FROM menu_items) AS menuState,
				(SELECT group_concat(id || ':' || status, ',') FROM orders) AS orderState,
				(SELECT COUNT(*) FROM merchant_push_subscriptions) AS subscriptionCount,
				(SELECT group_concat(id || ':' || status || ':' || attempt_count, ',')
					FROM web_push_notification_deliveries) AS pushDeliveryState,
				(SELECT group_concat(id || ':' || status || ':' || attempt_count, ',')
					FROM notification_deliveries) AS historicalDeliveryState`,
		).first<Record<string, unknown>>();
	}

	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM store_state_events"),
			env.DB.prepare(
				"UPDATE store_settings SET is_accepting_orders = 0, state_version = 0 WHERE id = 1",
			),
		]);
	});

	it("allows read methods without mutation headers", () => {
		for (const method of ["GET", "HEAD", "OPTIONS"]) {
			expect(isMerchantMutationRequestAllowed({ method })).toBe(true);
		}
	});

	it.each([
		["missing Origin", { "Sec-Fetch-Site": "same-origin" }],
		["null Origin", { Origin: "null", "Sec-Fetch-Site": "same-origin" }],
		["malformed Origin", { Origin: "not a url", "Sec-Fetch-Site": "same-origin" }],
		["cross origin", { Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" }],
		["hostname suffix attack", { Origin: "https://example.com.evil.example", "Sec-Fetch-Site": "same-origin" }],
		["insecure scheme", { Origin: "http://example.com", "Sec-Fetch-Site": "same-origin" }],
		["missing Fetch Metadata", { Origin: "https://example.com" }],
		["cross-site Fetch Metadata", { Origin: "https://example.com", "Sec-Fetch-Site": "cross-site" }],
		[
			"forged Referer",
			{ Origin: "https://evil.example", Referer: "https://example.com/merchant", "Sec-Fetch-Site": "same-origin" },
		],
	])("rejects %s without a D1 side effect", async (_label, headers) => {
		const response = await exports.default.fetch("https://example.com/api/merchant/store/resume", {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body,
		});
		const state = await env.DB.prepare(
			`SELECT is_accepting_orders, state_version,
				(SELECT COUNT(*) FROM store_state_events) AS event_count
			FROM store_settings WHERE id = 1`,
		).first<Record<string, number>>();

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: { code: "ORIGIN_DENIED" } });
		expect(state).toEqual({ is_accepting_orders: 0, state_version: 0, event_count: 0 });
	});

	it("accepts only the exact configured HTTPS origin and same-origin Fetch Metadata", () => {
		expect(
			isMerchantMutationRequestAllowed({
				method: "POST",
				expectedHostname: "example.com",
				origin: "https://example.com",
				secFetchSite: "same-origin",
			}),
		).toBe(true);
	});

	it("does not let a valid Access identity bypass the mutation Origin boundary", async () => {
		const identity = await authenticateMerchantRequest({
			devBypass: "false",
			expectedHostname: "merchant.example.com",
			requestUrl: "https://merchant.example.com/api/merchant/store/resume",
			accessAudience: "audience-id",
			accessTeamDomain: "https://team.cloudflareaccess.com",
			accessToken: "signed-token",
			verifyAccessIdentity: async () => ({ subject: "opaque-subject" }),
		});

		expect(identity).toEqual({ subject: "opaque-subject" });
		expect(
			isMerchantMutationRequestAllowed({
				method: "POST",
				expectedHostname: "merchant.example.com",
				origin: "https://evil.example",
				secFetchSite: "same-origin",
			}),
		).toBe(false);
	});

	it.each(
		merchantMutationRoutes.flatMap((route) => [
			[
				`${route.method} ${route.path}`,
				"Origin",
				route,
				{ Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" },
			],
			[
				`${route.method} ${route.path}`,
				"Sec-Fetch-Site",
				route,
				{ Origin: "https://example.com", "Sec-Fetch-Site": "cross-site" },
			],
		] as const),
	)("%s rejects an invalid %s boundary before any D1 side effect", async (_label, _boundary, route, headers) => {
		const before = await merchantMutationSnapshot();
		const response = await exports.default.fetch(`https://example.com${route.path}`, {
			method: route.method,
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify(route.body),
		});
		const after = await merchantMutationSnapshot();

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: { code: "ORIGIN_DENIED" } });
		expect(after).toEqual(before);
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
