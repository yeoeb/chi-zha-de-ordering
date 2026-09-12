import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/worker/index";
import { createOrder, type OrderSnapshot } from "../src/worker/order-creation";
import {
	deliverNewOrderNotification,
	FakeNotificationProvider,
	listMerchantNotificationDeliveries,
	retryNotificationDelivery,
} from "../src/worker/notifications";
import {
	buildWebPushMessage,
	createNotificationProvider,
	saveMerchantPushSubscription,
	WebPushNotificationProvider,
	type WebPushSender,
} from "../src/worker/web-push";

const orderRequest = {
	customerName: "測試顧客",
	customerPhone: "0912-345-678",
	specialOrder: false,
	items: [{ menuItemId: 1, quantity: 2, modifierOptionIds: [] }],
};
const fixedNow = new Date("2026-09-12T04:00:00.000Z");
const subscription = {
	endpoint: "https://push.example.test/subscription-1",
	expirationTime: null,
	keys: { p256dh: "test-p256dh-key", auth: "test-auth-key" },
};
const vapid = {
	publicKey: "test-public-key",
	privateKey: "test-private-key",
	subject: "mailto:merchant@example.test",
};

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (1, '人氣', 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (1, 1, '香雞排', '', 70, 10, 1)",
		),
	]);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM merchant_push_subscriptions"),
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

describe("durable new Order notification intent", () => {
	it("creates a web_push intent and records provider success", async () => {
		const result = await createOrder(env.DB, orderRequest, "push-success", fixedNow);
		if (result.replayed) throw new Error("Expected a new Order");
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
				"SELECT channel, status, attempt_count, last_error FROM notification_deliveries WHERE order_id = ?",
			)
			.bind(result.order.id)
			.first();

		expect(delivery).toEqual({ attempted: true, sent: true });
		expect(provider.notifications).toHaveLength(1);
		expect(stored).toEqual({
			channel: "web_push",
			status: "sent",
			attempt_count: 1,
			last_error: null,
		});
	});

	it("records push failure without rolling back the Order", async () => {
		const result = await createOrder(env.DB, orderRequest, "push-failure", fixedNow);
		if (result.replayed) throw new Error("Expected a new Order");
		const delivery = await deliverNewOrderNotification(
			env.DB,
			result.notificationDeliveryId,
			toNotification(result.order),
			new FakeNotificationProvider("PUSH_UNAVAILABLE"),
			fixedNow,
		);
		const order = await env.DB
			.prepare("SELECT status FROM orders WHERE id = ?")
			.bind(result.order.id)
			.first();

		expect(delivery).toMatchObject({ attempted: true, sent: false });
		expect(order).toEqual({ status: "pending" });
	});

	it("keeps one intent for an idempotent Order retry", async () => {
		const first = await createOrder(env.DB, orderRequest, "push-idempotent", fixedNow);
		const retry = await createOrder(env.DB, orderRequest, "push-idempotent", fixedNow);
		if (first.replayed) throw new Error("Expected a new Order");
		const count = await env.DB
			.prepare("SELECT COUNT(*) AS count FROM notification_deliveries WHERE order_id = ?")
			.bind(first.order.id)
			.first<{ count: number }>();

		expect(retry.replayed).toBe(true);
		expect(retry.order.id).toBe(first.order.id);
		expect(count?.count).toBe(1);
	});

	it("retries a failed delivery once and never resends a sent delivery", async () => {
		const result = await createOrder(env.DB, orderRequest, "push-retry", fixedNow);
		if (result.replayed) throw new Error("Expected a new Order");
		await deliverNewOrderNotification(
			env.DB,
			result.notificationDeliveryId,
			toNotification(result.order),
			new FakeNotificationProvider("INITIAL_FAILURE"),
			fixedNow,
		);

		const retryAt = new Date("2026-09-12T04:02:00.000Z");
		const retried = await retryNotificationDelivery(
			env.DB,
			result.notificationDeliveryId,
			new FakeNotificationProvider(),
			retryAt,
		);
		expect(retried).toMatchObject({ status: "sent", attemptCount: 2 });
		await expect(
			retryNotificationDelivery(
				env.DB,
				result.notificationDeliveryId,
				new FakeNotificationProvider(),
				retryAt,
			),
		).rejects.toMatchObject({ code: "NOTIFICATION_ALREADY_SENT" });
	});

	it("keeps delivery observability free of Customer and subscription secrets", async () => {
		const result = await createOrder(env.DB, orderRequest, "push-list", fixedNow);
		if (result.replayed) throw new Error("Expected a new Order");
		await deliverNewOrderNotification(
			env.DB,
			result.notificationDeliveryId,
			toNotification(result.order),
			new FakeNotificationProvider("FAILURE"),
			fixedNow,
		);
		const deliveries = await listMerchantNotificationDeliveries(env.DB);

		expect(deliveries[0]).toMatchObject({ channel: "web_push", status: "failed" });
		expect(deliveries[0]).not.toHaveProperty("customerPhone");
		expect(deliveries[0]).not.toHaveProperty("publicLookupToken");
		expect(deliveries[0]).not.toHaveProperty("endpoint");
		expect(deliveries[0]).not.toHaveProperty("p256dh");
	});
});

describe("Web Push provider", () => {
	it("builds only the minimal Merchant queue pointer payload", () => {
		const message = buildWebPushMessage({
			orderNumber: "CZ-TEST",
			total: 999,
			estimatedReadyAt: fixedNow.toISOString(),
			items: [{ name: "香雞排", quantity: 2 }],
		});
		const payload = JSON.parse(message.data) as Record<string, unknown>;

		expect(payload).toEqual({
			title: "吃炸的｜新訂單",
			body: "新訂單 #CZ-TEST",
			data: { url: "/merchant" },
		});
		expect(message.data).not.toContain("999");
		expect(message.data).not.toContain("香雞排");
	});

	it("delivers to a stored subscription without exposing its credentials", async () => {
		await saveMerchantPushSubscription(env.DB, subscription, fixedNow);
		const sends: Parameters<WebPushSender>[] = [];
		const sender: WebPushSender = async (...arguments_) => {
			sends.push(arguments_);
			return new Response(null, { status: 201 });
		};
		const provider = new WebPushNotificationProvider(env.DB, vapid, sender);
		await provider.notifyNewOrder({
			orderNumber: "CZ-PUSH",
			total: 70,
			estimatedReadyAt: fixedNow.toISOString(),
			items: [],
		});

		expect(sends).toHaveLength(1);
		expect(sends[0][0]).toMatchObject(subscription);
		expect(sends[0][2]).toEqual(vapid);
	});

	it.each([404, 410])("deletes a subscription after a terminal %i response", async (status) => {
		await saveMerchantPushSubscription(env.DB, subscription, fixedNow);
		const provider = new WebPushNotificationProvider(
			env.DB,
			vapid,
			async () => new Response(null, { status }),
		);
		await expect(
			provider.notifyNewOrder({
				orderNumber: "CZ-EXPIRED",
				total: 70,
				estimatedReadyAt: fixedNow.toISOString(),
				items: [],
			}),
		).rejects.toMatchObject({ code: "WEB_PUSH_DELIVERY_FAILED" });
		const count = await env.DB
			.prepare("SELECT COUNT(*) AS count FROM merchant_push_subscriptions")
			.first<{ count: number }>();
		expect(count?.count).toBe(0);
	});

	it("continues after one temporary failure and records a successful batch", async () => {
		const failureSubscription = {
			...subscription,
			endpoint: "https://push.example.test/failure",
		};
		const successSubscription = {
			...subscription,
			endpoint: "https://push.example.test/success",
		};
		await saveMerchantPushSubscription(env.DB, failureSubscription, fixedNow);
		await saveMerchantPushSubscription(
			env.DB,
			successSubscription,
			new Date(fixedNow.getTime() + 1_000),
		);
		const attemptedEndpoints: string[] = [];
		const provider = new WebPushNotificationProvider(env.DB, vapid, async (candidate) => {
			attemptedEndpoints.push(candidate.endpoint);
			return new Response(null, {
				status: candidate.endpoint === failureSubscription.endpoint ? 500 : 201,
			});
		});
		const result = await createOrder(env.DB, orderRequest, "mixed-push-delivery", fixedNow);
		if (result.replayed) throw new Error("Expected a new Order");

		const delivery = await deliverNewOrderNotification(
			env.DB,
			result.notificationDeliveryId,
			toNotification(result.order),
			provider,
			fixedNow,
		);
		const { results } = await env.DB
			.prepare(
				`SELECT
					endpoint,
					last_success_at AS lastSuccessAt,
					last_failure_at AS lastFailureAt
				FROM merchant_push_subscriptions`,
			)
			.all<{
				endpoint: string;
				lastSuccessAt: string | null;
				lastFailureAt: string | null;
			}>();
		const subscriptionsByEndpoint = new Map(results.map((row) => [row.endpoint, row]));
		const storedDelivery = await env.DB
			.prepare(
				`SELECT status, attempt_count AS attemptCount, last_error AS lastError
				FROM notification_deliveries WHERE id = ?`,
			)
			.bind(result.notificationDeliveryId)
			.first();
		const storedOrder = await env.DB
			.prepare("SELECT status FROM orders WHERE id = ?")
			.bind(result.order.id)
			.first();

		expect(attemptedEndpoints).toEqual([
			failureSubscription.endpoint,
			successSubscription.endpoint,
		]);
		expect(delivery).toEqual({ attempted: true, sent: true });
		expect(subscriptionsByEndpoint.get(failureSubscription.endpoint)).toMatchObject({
			lastSuccessAt: null,
			lastFailureAt: expect.any(String),
		});
		expect(subscriptionsByEndpoint.get(successSubscription.endpoint)).toMatchObject({
			lastSuccessAt: expect.any(String),
			lastFailureAt: null,
		});
		expect(storedDelivery).toEqual({ status: "sent", attemptCount: 1, lastError: null });
		expect(storedOrder).toEqual({ status: "pending" });
	});

	it("retains subscriptions after temporary HTTP and network failures", async () => {
		const cases: Array<{ label: string; sender: WebPushSender }> = [
			{ label: "HTTP 429", sender: async () => new Response(null, { status: 429 }) },
			{ label: "HTTP 500", sender: async () => new Response(null, { status: 500 }) },
			{
				label: "network error",
				sender: async () => {
					throw new Error("temporary network failure");
				},
			},
		];

		for (const failureCase of cases) {
			await env.DB.prepare("DELETE FROM merchant_push_subscriptions").run();
			await saveMerchantPushSubscription(env.DB, subscription, fixedNow);
			const provider = new WebPushNotificationProvider(env.DB, vapid, failureCase.sender);

			await expect(
				provider.notifyNewOrder({
					orderNumber: `CZ-${failureCase.label}`,
					total: 70,
					estimatedReadyAt: fixedNow.toISOString(),
					items: [],
				}),
			).rejects.toMatchObject({ code: "WEB_PUSH_DELIVERY_FAILED" });
			const stored = await env.DB
				.prepare(
					`SELECT COUNT(*) AS count, last_failure_at AS lastFailureAt
					FROM merchant_push_subscriptions`,
				)
				.first<{ count: number; lastFailureAt: string | null }>();

			expect(stored, failureCase.label).toEqual({
				count: 1,
				lastFailureAt: expect.any(String),
			});
		}
	});

	it("keeps the Order committed when every Web Push request fails", async () => {
		await saveMerchantPushSubscription(env.DB, subscription, fixedNow);
		const result = await createOrder(env.DB, orderRequest, "real-push-failure", fixedNow);
		if (result.replayed) throw new Error("Expected a new Order");
		const provider = new WebPushNotificationProvider(
			env.DB,
			vapid,
			async () => new Response(null, { status: 503 }),
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
			.first();

		expect(delivery).toMatchObject({ attempted: true, sent: false });
		expect(storedOrder).toEqual({ status: "pending" });
	});

	it("starts safely without VAPID configuration and cannot select Fake in production", async () => {
		const provider = createNotificationProvider({}, env.DB);
		await expect(
			provider.notifyNewOrder({
				orderNumber: "CZ-NO-CONFIG",
				total: 70,
				estimatedReadyAt: fixedNow.toISOString(),
				items: [],
			}),
		).rejects.toMatchObject({ code: "WEB_PUSH_NOT_CONFIGURED" });
		expect(provider).not.toBeInstanceOf(FakeNotificationProvider);
		expect((await exports.default.fetch("https://example.com/api/health")).status).toBe(200);
	});
});

describe("Merchant Push subscription API", () => {
	it("keeps subscription mutations behind the Merchant guard", async () => {
		const response = await app.request(
			new Request("https://merchant.example.com/api/merchant/push/subscriptions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(subscription),
			}),
			undefined,
			{ DB: env.DB } as Env,
			{} as ExecutionContext,
		);
		expect(response.status).toBe(403);
	});

	it("creates and idempotently updates the same endpoint", async () => {
		const request = (body: unknown) =>
			exports.default.fetch("https://example.com/api/merchant/push/subscriptions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		const first = await request(subscription);
		const second = await request({
			...subscription,
			keys: { p256dh: "updated-p256dh", auth: "updated-auth" },
		});
		const stored = await env.DB
			.prepare("SELECT COUNT(*) AS count, p256dh, auth FROM merchant_push_subscriptions")
			.first<{ count: number; p256dh: string; auth: string }>();

		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		expect(await first.json()).toEqual({ subscribed: true });
		expect(stored).toEqual({ count: 1, p256dh: "updated-p256dh", auth: "updated-auth" });
	});

	it("unsubscribes idempotently", async () => {
		await saveMerchantPushSubscription(env.DB, subscription, fixedNow);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const response = await exports.default.fetch(
				"https://example.com/api/merchant/push/subscriptions",
				{
					method: "DELETE",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ endpoint: subscription.endpoint }),
				},
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ subscribed: false });
		}
	});

	it("retires every LINE API route", async () => {
		const webhook = await exports.default.fetch("https://example.com/api/line/webhook", {
			method: "POST",
		});
		const pairing = await exports.default.fetch("https://example.com/api/merchant/line/pairing", {
			method: "POST",
		});
		const status = await exports.default.fetch("https://example.com/api/merchant/line/status");

		expect(webhook.status).toBe(404);
		expect(pairing.status).toBe(404);
		expect(status.status).toBe(404);
	});
});
