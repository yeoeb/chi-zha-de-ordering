import { setupOrderAcceptanceTests } from "./order-acceptance-fixture";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	CheckoutQuoteError,
	createQuoteFingerprint,
	validateAndPriceCart,
} from "../src/worker/checkout-quote";
import {
	createOrder,
	OrderCreationError,
	type CreateOrderRequest,
} from "../src/worker/order-creation";

let request: CreateOrderRequest;
const requestItems = [{ menuItemId: 1, quantity: 1, modifierOptionIds: [10, 20] }];
const requestBase = {
	customerName: "併發測試",
	customerPhone: "0912345678",
	customerNote: null,
	packagingPreference: "together" as const,
	specialOrder: false,
	items: requestItems,
};
const now = new Date("2026-09-22T10:00:00.000Z");

function interleaveBeforeAtomicWrite(action: () => Promise<unknown>) {
	let batchCalls = 0;
	let interleaved = false;
	return new Proxy(env.DB, {
		get(target, property, receiver) {
			if (property === "batch") {
				return async (statements: D1PreparedStatement[]) => {
					batchCalls += 1;
					if (batchCalls === 2 && !interleaved) {
						interleaved = true;
						await action();
					}
					return target.batch(statements);
				};
			}
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

async function orderCount() {
	return (await env.DB.prepare("SELECT COUNT(*) AS count FROM orders").first<{ count: number }>())
		?.count ?? 0;
}

setupOrderAcceptanceTests();

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES (1, '分類', 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO menu_items (id, category_id, name, description, price, sort_order, is_available) VALUES (1, 1, '雞排', '', 85, 10, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_groups (id, menu_item_id, name, selection_type, is_required, sort_order, is_active) VALUES (1, 1, '辣度', 'single', 1, 10, 1), (2, 1, '切法', 'single', 1, 20, 1)",
		),
		env.DB.prepare(
			"INSERT INTO modifier_options (id, modifier_group_id, name, price_delta, sort_order, is_active) VALUES (10, 1, '不辣', 0, 10, 1), (20, 2, '不切', 0, 10, 1)",
		),
	]);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM web_push_notification_deliveries"),
		env.DB.prepare("DELETE FROM order_item_modifiers"),
		env.DB.prepare("DELETE FROM order_items"),
		env.DB.prepare("DELETE FROM orders"),
		env.DB.prepare("DELETE FROM store_state_events"),
		env.DB.prepare(
			"UPDATE store_settings SET is_accepting_orders = 1, state_version = 0, base_prep_minutes = 15, normal_order_minutes = 5, special_extra_minutes = 10 WHERE id = 1",
		),
		env.DB.prepare("UPDATE menu_categories SET is_active = 1 WHERE id = 1"),
		env.DB.prepare(
			"UPDATE menu_items SET name = '雞排', price = 85, is_available = 1, is_archived = 0 WHERE id = 1",
		),
		env.DB.prepare("UPDATE modifier_groups SET is_required = 1, is_active = 1 WHERE id IN (1, 2)"),
		env.DB.prepare("UPDATE modifier_options SET is_active = 1, price_delta = 0 WHERE id IN (10, 20)"),
	]);
	request = {
		...requestBase,
		quoteFingerprint: await createQuoteFingerprint(
			await validateAndPriceCart(env.DB, requestItems),
		),
	};
});

describe("Order creation interleavings", () => {
	it("linearizes two truly concurrent identical requests to one Order", async () => {
		const results = await Promise.all([
			createOrder(env.DB, request, "same-key-concurrent", now),
			createOrder(env.DB, request, "same-key-concurrent", now),
		]);

		expect(await orderCount()).toBe(1);
		expect(new Set(results.map((result) => result.order.publicLookupToken)).size).toBe(1);
		expect(results.filter((result) => result.replayed)).toHaveLength(1);
	});

	it("rejects a concurrent different body using the same key", async () => {
		const different = { ...request, customerNote: "不同內容" };
		const results = await Promise.allSettled([
			createOrder(env.DB, request, "same-key-different-body", now),
			createOrder(env.DB, different, "same-key-different-body", now),
		]);

		expect(await orderCount()).toBe(1);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({
			code: "IDEMPOTENCY_KEY_CONFLICT",
		});
	});

	it("does not commit after the Store pauses between validation and the atomic write", async () => {
		const db = interleaveBeforeAtomicWrite(() =>
			env.DB.prepare(
				"UPDATE store_settings SET is_accepting_orders = 0, state_version = state_version + 1 WHERE id = 1",
			).run(),
		);

		await expect(createOrder(db, request, "pause-race", now)).rejects.toMatchObject({
			code: "STORE_NOT_ACCEPTING_ORDERS",
		} satisfies Partial<OrderCreationError>);
		expect(await orderCount()).toBe(0);
	});

	it("does not commit an item sold out between validation and the atomic write", async () => {
		const db = interleaveBeforeAtomicWrite(() =>
			env.DB.prepare("UPDATE menu_items SET is_available = 0 WHERE id = 1").run(),
		);

		await expect(createOrder(db, request, "sold-out-race", now)).rejects.toMatchObject({
			code: "UNAVAILABLE_ITEM",
		} satisfies Partial<CheckoutQuoteError>);
		expect(await orderCount()).toBe(0);
	});

	it("rejects an unconfirmed Admin price change in the validation/write window", async () => {
		const db = interleaveBeforeAtomicWrite(() =>
			env.DB.prepare("UPDATE menu_items SET price = 95 WHERE id = 1").run(),
		);

		await expect(createOrder(db, request, "price-race", now)).rejects.toMatchObject({
			code: "QUOTE_CHANGED",
		} satisfies Partial<OrderCreationError>);
		expect(await orderCount()).toBe(0);
	});

	it("rejects an unconfirmed modifier price change in the validation/write window", async () => {
		const db = interleaveBeforeAtomicWrite(() =>
			env.DB.prepare("UPDATE modifier_options SET price_delta = 10 WHERE id = 10").run(),
		);

		await expect(createOrder(db, request, "modifier-price-race", now)).rejects.toMatchObject({
			code: "QUOTE_CHANGED",
		} satisfies Partial<OrderCreationError>);
		expect(await orderCount()).toBe(0);
	});

	it("serializes queue-derived ETAs for concurrent distinct Orders", async () => {
		const [first, second] = await Promise.all([
			createOrder(env.DB, request, "queue-concurrent-a", now),
			createOrder(env.DB, request, "queue-concurrent-b", now),
		]);
		const leadMinutes = [first, second]
			.map((result) => (Date.parse(result.order.estimatedReadyAt) - now.getTime()) / 60_000)
			.sort((left, right) => left - right);

		expect(leadMinutes).toEqual([20, 25]);
		expect(await orderCount()).toBe(2);
	});

	it("persists the buffered duration on the next five-minute clock boundary", async () => {
		await env.DB.prepare(
			"UPDATE store_settings SET base_prep_minutes = 12, normal_order_minutes = 0, special_extra_minutes = 0 WHERE id = 1",
		).run();
		const result = await createOrder(
			env.DB,
			request,
			"rounded-ready-boundary",
			new Date("2026-09-22T10:03:27.500Z"),
		);

		expect(result.order.estimatedReadyAt).toBe("2026-09-22T10:25:00.000Z");
	});
});
