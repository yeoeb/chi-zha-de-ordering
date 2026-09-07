import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOrder, type OrderSnapshot } from "../src/worker/order-creation";
import {
	buildLineNewOrderMessage,
	deliverNewOrderNotification,
	FakeNotificationProvider,
	LineNotificationProvider,
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
