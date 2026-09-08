import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/worker/index";
import { createOrder, type OrderSnapshot } from "../src/worker/order-creation";
import {
	buildLineNewOrderMessage,
	createNotificationProvider,
	deliverNewOrderNotification,
	FakeNotificationProvider,
	LineNotificationProvider,
	listMerchantNotificationDeliveries,
	retryNotificationDelivery,
} from "../src/worker/notifications";

const orderRequest = {
	customerName: "測試顧客",
	customerPhone: "0912-345-678",
	specialOrder: false,
	items: [{ menuItemId: 1, quantity: 2, modifierOptionIds: [] }],
};

const fixedNow = new Date("2026-09-07T04:00:00.000Z");

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
		env.DB.prepare("DELETE FROM line_merchant_binding"),
		env.DB.prepare("DELETE FROM line_merchant_pairing_challenge"),
		env.DB.prepare("DELETE FROM notification_deliveries"),
		env.DB.prepare("DELETE FROM order_item_modifiers"),
		env.DB.prepare("DELETE FROM order_items"),
		env.DB.prepare("DELETE FROM orders"),
	]);
});

function toNotification(order: OrderSnapshot) {
	return {
		orderNumber: order.orderNumber,
		total: order.total,
		estimatedReadyAt: order.estimatedReadyAt,
		items: order.items,
	};
}

describe("new Order notification delivery", () => {
	it("atomically creates one intent and records fake provider success", async () => {
		const result = await createOrder(env.DB, orderRequest, "notify-success", fixedNow);

		expect(result.replayed).toBe(false);
		if (result.replayed) throw new Error("Expected a newly created Order");

		const provider = new FakeNotificationProvider();
		const delivery = await deliverNewOrderNotification(
			env.DB,
			result.notificationDeliveryId,
			toNotification(result.order),
			provider,
			fixedNow,
		);
		const stored = await env.DB
			.prepare(
				"SELECT status, attempt_count, last_error, sent_at FROM notification_deliveries WHERE order_id = ?",
			)
			.bind(result.order.id)
			.first<{
				status: string;
				attempt_count: number;
				last_error: string | null;
				sent_at: string | null;
			}>();

		expect(delivery).toEqual({ attempted: true, sent: true });
		expect(provider.notifications).toHaveLength(1);
		expect(stored).toEqual({
			status: "sent",
			attempt_count: 1,
			last_error: null,
			sent_at: fixedNow.toISOString(),
		});
	});

	it("records provider failure without rolling back or changing the Order", async () => {
		const result = await createOrder(env.DB, orderRequest, "notify-failure", fixedNow);
		if (result.replayed) throw new Error("Expected a newly created Order");

		const delivery = await deliverNewOrderNotification(
			env.DB,
			result.notificationDeliveryId,
			toNotification(result.order),
			new FakeNotificationProvider("FAKE_UNAVAILABLE"),
			fixedNow,
		);
		const order = await env.DB
			.prepare("SELECT status FROM orders WHERE id = ?")
			.bind(result.order.id)
			.first<{ status: string }>();
		const stored = await env.DB
			.prepare(
				"SELECT status, attempt_count, last_error FROM notification_deliveries WHERE order_id = ?",
			)
			.bind(result.order.id)
			.first<{ status: string; attempt_count: number; last_error: string }>();

		expect(delivery).toMatchObject({ attempted: true, sent: false });
		expect(order).toEqual({ status: "pending" });
		expect(stored).toEqual({
			status: "failed",
			attempt_count: 1,
			last_error: "FAKE_UNAVAILABLE: Fake provider delivery failed",
		});
	});

	it("creates no duplicate intent and claims at most one attempt on an idempotent retry", async () => {
		const first = await createOrder(env.DB, orderRequest, "notify-idempotent", fixedNow);
		const retry = await createOrder(env.DB, orderRequest, "notify-idempotent", fixedNow);
		if (first.replayed) throw new Error("Expected a newly created Order");

		const provider = new FakeNotificationProvider();
		await deliverNewOrderNotification(
			env.DB,
			first.notificationDeliveryId,
			toNotification(first.order),
			provider,
			fixedNow,
		);
		const duplicateAttempt = await deliverNewOrderNotification(
			env.DB,
			first.notificationDeliveryId,
			toNotification(first.order),
			provider,
			fixedNow,
		);
		const count = await env.DB
			.prepare("SELECT COUNT(*) AS count FROM notification_deliveries WHERE order_id = ?")
			.bind(first.order.id)
			.first<{ count: number }>();

		expect(retry.replayed).toBe(true);
		expect(retry.order.id).toBe(first.order.id);
		expect(count?.count).toBe(1);
		expect(provider.notifications).toHaveLength(1);
		expect(duplicateAttempt).toEqual({ attempted: false });
	});

	it("retries a failed delivery successfully and increments attempt metadata", async () => {
		const result = await createOrder(env.DB, orderRequest, "retry-success", fixedNow);
		if (result.replayed) throw new Error("Expected a newly created Order");

		await deliverNewOrderNotification(
			env.DB,
			result.notificationDeliveryId,
			toNotification(result.order),
			new FakeNotificationProvider("INITIAL_FAILURE"),
			fixedNow,
		);
		const retryAt = new Date("2026-09-07T04:02:00.000Z");
		const provider = new FakeNotificationProvider();
		const delivery = await retryNotificationDelivery(
			env.DB,
			result.notificationDeliveryId,
			provider,
			retryAt,
		);

		expect(provider.notifications).toHaveLength(1);
		expect(delivery).toMatchObject({
			status: "sent",
			attemptCount: 2,
			lastAttemptAt: retryAt.toISOString(),
			sentAt: retryAt.toISOString(),
			lastError: null,
		});
	});

	it("keeps a failed retry observable and increments attempt_count", async () => {
		const result = await createOrder(env.DB, orderRequest, "retry-failure", fixedNow);
		if (result.replayed) throw new Error("Expected a newly created Order");

		await deliverNewOrderNotification(
			env.DB,
			result.notificationDeliveryId,
			toNotification(result.order),
			new FakeNotificationProvider("INITIAL_FAILURE"),
			fixedNow,
		);
		const retryAt = new Date("2026-09-07T04:02:00.000Z");
		const delivery = await retryNotificationDelivery(
			env.DB,
			result.notificationDeliveryId,
			new FakeNotificationProvider("RETRY_FAILURE"),
			retryAt,
		);

		expect(delivery).toMatchObject({
			status: "failed",
			attemptCount: 2,
			lastAttemptAt: retryAt.toISOString(),
			lastError: "RETRY_FAILURE: Fake provider delivery failed",
		});
		await expect(
			env.DB.prepare("SELECT status FROM orders WHERE id = ?").bind(result.order.id).first(),
		).resolves.toEqual({ status: "pending" });
	});

	it("never resends a sent delivery and reports unknown delivery IDs", async () => {
		const result = await createOrder(env.DB, orderRequest, "retry-sent", fixedNow);
		if (result.replayed) throw new Error("Expected a newly created Order");

		await deliverNewOrderNotification(
			env.DB,
			result.notificationDeliveryId,
			toNotification(result.order),
			new FakeNotificationProvider(),
			fixedNow,
		);
		const retryProvider = new FakeNotificationProvider();

		await expect(
			retryNotificationDelivery(
				env.DB,
				result.notificationDeliveryId,
				retryProvider,
				new Date("2026-09-07T04:02:00.000Z"),
			),
		).rejects.toMatchObject({ status: 409, code: "NOTIFICATION_ALREADY_SENT" });
		await expect(
			retryNotificationDelivery(env.DB, "missing-delivery", retryProvider, fixedNow),
		).rejects.toMatchObject({ status: 404, code: "NOTIFICATION_DELIVERY_NOT_FOUND" });
		expect(retryProvider.notifications).toHaveLength(0);
	});

	it("rejects an active pending attempt but recovers it after the stale threshold", async () => {
		const result = await createOrder(env.DB, orderRequest, "retry-stale-pending", fixedNow);
		if (result.replayed) throw new Error("Expected a newly created Order");

		await env.DB
			.prepare(
				`UPDATE notification_deliveries
				SET status = 'pending', attempt_count = 1, last_attempt_at = ?
				WHERE id = ?`,
			)
			.bind(fixedNow.toISOString(), result.notificationDeliveryId)
			.run();
		const provider = new FakeNotificationProvider();

		await expect(
			retryNotificationDelivery(
				env.DB,
				result.notificationDeliveryId,
				provider,
				new Date("2026-09-07T04:00:30.000Z"),
			),
		).rejects.toMatchObject({
			status: 409,
			code: "NOTIFICATION_DELIVERY_IN_PROGRESS",
		});

		const recovered = await retryNotificationDelivery(
			env.DB,
			result.notificationDeliveryId,
			provider,
			new Date("2026-09-07T04:01:01.000Z"),
		);
		expect(recovered).toMatchObject({ status: "sent", attemptCount: 2 });
		expect(provider.notifications).toHaveLength(1);
	});

	it("enforces notification uniqueness in D1", async () => {
		const result = await createOrder(env.DB, orderRequest, "durable-uniqueness", fixedNow);
		if (result.replayed) throw new Error("Expected a newly created Order");

		await expect(
			env.DB
				.prepare(
					`INSERT INTO notification_deliveries (
						id, order_id, channel, event_type, status, attempt_count, created_at
					) VALUES (?, ?, 'line', 'new_order', 'pending', 0, ?)`,
				)
				.bind("duplicate-intent", result.order.id, fixedNow.toISOString())
				.run(),
		).rejects.toThrow(/UNIQUE constraint failed/);
	});

	it("lists only operational fields with failed deliveries first", async () => {
		const sent = await createOrder(env.DB, orderRequest, "list-sent", fixedNow);
		const failed = await createOrder(
			env.DB,
			orderRequest,
			"list-failed",
			new Date("2026-09-07T04:01:00.000Z"),
		);
		if (sent.replayed || failed.replayed) throw new Error("Expected newly created Orders");

		await deliverNewOrderNotification(
			env.DB,
			sent.notificationDeliveryId,
			toNotification(sent.order),
			new FakeNotificationProvider(),
			fixedNow,
		);
		await deliverNewOrderNotification(
			env.DB,
			failed.notificationDeliveryId,
			toNotification(failed.order),
			new FakeNotificationProvider("FAILURE"),
			fixedNow,
		);
		const deliveries = await listMerchantNotificationDeliveries(env.DB);

		expect(deliveries.map((delivery) => delivery.status)).toEqual(["failed", "sent"]);
		expect(deliveries[0]).not.toHaveProperty("customerPhone");
		expect(deliveries[0]).not.toHaveProperty("publicLookupToken");
	});

	it("keeps Merchant notification endpoints behind the existing guard", async () => {
		const denied = await app.request(
			new Request("https://merchant.example.com/api/merchant/notifications/missing/retry", {
				method: "POST",
			}),
			undefined,
			{ DB: env.DB } as Env,
			{} as ExecutionContext,
		);
		const localList = await exports.default.fetch(
			"https://example.com/api/merchant/notifications",
		);

		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({
			error: { code: "MERCHANT_ACCESS_DENIED" },
		});
		expect(localList.status).toBe(200);
		expect(localList.headers.get("Cache-Control")).toContain("no-store");
	});

	it("retries through the protected Merchant action with the explicit test bypass", async () => {
		const result = await createOrder(env.DB, orderRequest, "merchant-retry-route", fixedNow);
		if (result.replayed) throw new Error("Expected a newly created Order");

		await deliverNewOrderNotification(
			env.DB,
			result.notificationDeliveryId,
			toNotification(result.order),
			new FakeNotificationProvider("INITIAL_FAILURE"),
			fixedNow,
		);
		const response = await exports.default.fetch(
			`https://example.com/api/merchant/notifications/${result.notificationDeliveryId}/retry`,
			{ method: "POST" },
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			delivery: { status: "sent", attemptCount: 2, lastError: null },
		});
	});
});

describe("LINE notification provider", () => {
	const notification = {
		orderNumber: "CZ-20260907-TEST",
		total: 170,
		estimatedReadyAt: "2026-09-07T13:35:00.000Z",
		items: [
			{
				menuItemId: 1,
				name: "雞排",
				unitPrice: 85,
				quantity: 2,
				lineTotal: 170,
				modifiers: [],
			},
		],
	};

	it("uses the LINE push endpoint, Bearer token, recipient, and bounded safe message", async () => {
		const requests: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
		const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requests.push([input, init]);
			return new Response(null, { status: 200 });
		}) as typeof fetch;
		const provider = new LineNotificationProvider(
			"secret-channel-token",
			"merchant-recipient",
			fetcher,
		);

		await provider.notifyNewOrder(notification);

		expect(requests).toHaveLength(1);
		const [url, init] = requests[0];
		const headers = new Headers(init?.headers);
		const body = JSON.parse(String(init?.body)) as {
			to: string;
			messages: Array<{ type: string; text: string }>;
		};

		expect(url).toBe("https://api.line.me/v2/bot/message/push");
		expect(init?.method).toBe("POST");
		expect(headers.get("Authorization")).toBe("Bearer secret-channel-token");
		expect(headers.get("Content-Type")).toBe("application/json");
		expect(body.to).toBe("merchant-recipient");
		expect(body.messages[0]).toMatchObject({ type: "text" });
		expect(body.messages[0].text).toContain("雞排 ×2");
		expect(body.messages[0].text).not.toContain("0912-345-678");
		expect(body.messages[0].text.length).toBeLessThanOrEqual(1_000);
	});

	it("sanitizes non-2xx and network failures without exposing the token", async () => {
		const token = "must-never-appear-in-errors";
		const httpProvider = new LineNotificationProvider(
			token,
			"merchant-recipient",
			(async () => new Response("provider detail", { status: 429 })) as typeof fetch,
		);
		const networkProvider = new LineNotificationProvider(
			token,
			"merchant-recipient",
			(async () => {
				throw new Error(`network failed with ${token}`);
			}) as typeof fetch,
		);

		await expect(httpProvider.notifyNewOrder(notification)).rejects.toMatchObject({
			code: "LINE_HTTP_ERROR",
		});
		await expect(networkProvider.notifyNewOrder(notification)).rejects.toMatchObject({
			code: "LINE_NETWORK_ERROR",
		});

		for (const provider of [httpProvider, networkProvider]) {
			try {
				await provider.notifyNewOrder(notification);
			} catch (error) {
				expect(String(error)).not.toContain(token);
			}
		}
	});

	it("builds a short message without customer contact or internal identifiers", () => {
		const message = buildLineNewOrderMessage(notification);

		expect(message).toContain("吃炸的｜新訂單");
		expect(message).toContain("訂單 #CZ-20260907-TEST");
		expect(message).toContain("總計 $170");
		expect(message).not.toContain("customerPhone");
		expect(message).not.toContain("publicLookupToken");
	});
});

describe("notification provider selection", () => {
	const notification = {
		orderNumber: "CZ-PROVIDER-SELECTION",
		total: 70,
		estimatedReadyAt: "2026-09-07T13:35:00.000Z",
		items: [{ name: "香雞排", quantity: 1 }],
	};

	it("requires the explicit development bypass before Fake can be selected", async () => {
		const productionProvider = createNotificationProvider(
			{
				NOTIFICATION_PROVIDER: "fake",
			},
			env.DB,
		);
		const developmentProvider = createNotificationProvider(
			{
				NOTIFICATION_PROVIDER: "fake",
				MERCHANT_DEV_BYPASS: "true",
			},
			env.DB,
		);

		await expect(productionProvider.notifyNewOrder(notification)).rejects.toMatchObject({
			code: "NOTIFICATION_DISABLED",
		});
		expect(developmentProvider).toBeInstanceOf(FakeNotificationProvider);
	});

	it("resolves the LINE recipient only from the D1 Merchant binding", async () => {
		const requests: Array<RequestInit | undefined> = [];
		const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			requests.push(init);
			return new Response(null, { status: 200 });
		}) as typeof fetch;
		const provider = createNotificationProvider(
			{
				NOTIFICATION_PROVIDER: "line",
				LINE_CHANNEL_ACCESS_TOKEN: "test-channel-token",
			},
			env.DB,
			fetcher,
		);

		await expect(provider.notifyNewOrder(notification)).rejects.toMatchObject({
			code: "LINE_RECIPIENT_NOT_PAIRED",
		});
		expect(requests).toHaveLength(0);

		await env.DB.prepare(
			`INSERT INTO line_merchant_binding (id, recipient_user_id, paired_at, updated_at)
			VALUES (1, ?, ?, ?)`,
		)
			.bind(`U${"a".repeat(32)}`, fixedNow.toISOString(), fixedNow.toISOString())
			.run();
		await provider.notifyNewOrder(notification);

		const body = JSON.parse(String(requests[0]?.body)) as { to: string };
		expect(body.to).toBe(`U${"a".repeat(32)}`);
	});

	it("keeps a durable Order when the bound LINE provider fails", async () => {
		await env.DB.prepare(
			`INSERT INTO line_merchant_binding (id, recipient_user_id, paired_at, updated_at)
			VALUES (1, ?, ?, ?)`,
		)
			.bind(`U${"b".repeat(32)}`, fixedNow.toISOString(), fixedNow.toISOString())
			.run();
		const result = await createOrder(env.DB, orderRequest, "line-provider-failure", fixedNow);
		if (result.replayed) throw new Error("Expected a newly created Order");
		const provider = createNotificationProvider(
			{
				NOTIFICATION_PROVIDER: "line",
				LINE_CHANNEL_ACCESS_TOKEN: "test-channel-token",
			},
			env.DB,
			(async () => new Response(null, { status: 503 })) as typeof fetch,
		);

		const delivery = await deliverNewOrderNotification(
			env.DB,
			result.notificationDeliveryId,
			toNotification(result.order),
			provider,
			fixedNow,
		);
		const storedOrder = await env.DB
			.prepare("SELECT status FROM orders WHERE id = ?")
			.bind(result.order.id)
			.first<{ status: string }>();

		expect(delivery).toMatchObject({ attempted: true, sent: false });
		expect(storedOrder).toEqual({ status: "pending" });
	});
});
