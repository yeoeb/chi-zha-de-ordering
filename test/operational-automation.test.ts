import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { transitionMerchantOrder } from "../src/worker/merchant-orders";
import {
	performBusyModeOperation,
	processDueAutoRejections,
} from "../src/worker/operational-automation";

const actor = "local-test-merchant-subject";
const auditKey = "local-test-audit-key-32-bytes-minimum";

function tokenFor(id: string) {
	return Array.from({ length: 64 }, (_, index) =>
		((id.charCodeAt(index % id.length) + index) % 16).toString(16),
	).join("");
}

async function insertOrder(input: {
	id: string;
	createdAt: string;
	estimatedReadyAt: string;
	status?: "pending" | "accepted";
	orderSource?: "online" | "onsite";
}) {
	const status = input.status ?? "pending";
	await env.DB.prepare(
		`INSERT INTO orders (
			id, public_lookup_token, order_number, status, order_source, total_amount,
			estimated_ready_at, created_at, accepted_at, customer_name, customer_phone,
			packaging_preference, shortage_policy, special_order, idempotency_key,
			request_fingerprint
		) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, '測試顧客', '0912345678',
			'together', 'continue_available', 0, ?, ?)` ,
	).bind(
		input.id,
		tokenFor(input.id),
		`AUTO-${input.id}`,
		status,
		input.orderSource ?? "online",
		input.estimatedReadyAt,
		input.createdAt,
		status === "accepted" ? input.createdAt : null,
		`key-${input.id}`,
		"a".repeat(64),
	).run();
}

async function readOrder(id: string) {
	return env.DB.prepare(
		`SELECT status, estimated_ready_at AS estimatedReadyAt,
			rejection_reason AS rejectionReason
		FROM orders WHERE id = ?`,
	).bind(id).first<{
		status: string;
		estimatedReadyAt: string;
		rejectionReason: string | null;
	}>();
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM order_auto_rejection_events"),
		env.DB.prepare("DELETE FROM store_busy_mode_events"),
		env.DB.prepare("DELETE FROM order_item_modifiers"),
		env.DB.prepare("DELETE FROM order_items"),
		env.DB.prepare("DELETE FROM orders"),
		env.DB.prepare(
			`UPDATE store_settings SET is_accepting_orders = 1, state_version = 0,
				busy_mode = 0, missed_order_count = 0, auto_pause_reason = NULL
			WHERE id = 1`,
		),
	]);
});

describe("operational automation", () => {
	it("busy mode extends only short pending online deadlines and never retracts them", async () => {
		await insertOrder({ id: "short", createdAt: "2026-09-30T09:00:00.000Z", estimatedReadyAt: "2026-09-30T09:20:00.000Z" });
		await insertOrder({ id: "later", createdAt: "2026-09-30T09:00:00.000Z", estimatedReadyAt: "2026-09-30T09:50:00.000Z" });
		await insertOrder({ id: "accepted", status: "accepted", createdAt: "2026-09-30T09:00:00.000Z", estimatedReadyAt: "2026-09-30T09:20:00.000Z" });
		await insertOrder({ id: "onsite", orderSource: "onsite", createdAt: "2026-09-30T09:00:00.000Z", estimatedReadyAt: "2026-09-30T09:20:00.000Z" });

		const enabled = await performBusyModeOperation({
			db: env.DB,
			request: {
				operationId: "11111111-1111-4111-8111-111111111111",
				expectedBusyMode: false,
				expectedStateVersion: 0,
				busyMode: true,
			},
			actorSubject: actor,
			auditActorHashKey: auditKey,
			now: new Date("2026-09-30T09:02:01.000Z"),
		});

		expect(enabled).toMatchObject({ outcome: "APPLIED", busyMode: true, extendedOrderCount: 1 });
		expect((await readOrder("short"))?.estimatedReadyAt).toBe("2026-09-30T09:35:00.000Z");
		expect((await readOrder("later"))?.estimatedReadyAt).toBe("2026-09-30T09:50:00.000Z");
		expect((await readOrder("accepted"))?.estimatedReadyAt).toBe("2026-09-30T09:20:00.000Z");
		expect((await readOrder("onsite"))?.estimatedReadyAt).toBe("2026-09-30T09:20:00.000Z");

		const disabled = await performBusyModeOperation({
			db: env.DB,
			request: {
				operationId: "22222222-2222-4222-8222-222222222222",
				expectedBusyMode: true,
				expectedStateVersion: 1,
				busyMode: false,
			},
			actorSubject: actor,
			auditActorHashKey: auditKey,
			now: new Date("2026-09-30T09:03:00.000Z"),
		});
		expect(disabled).toMatchObject({ outcome: "APPLIED", busyMode: false, extendedOrderCount: 0 });
		expect((await readOrder("short"))?.estimatedReadyAt).toBe("2026-09-30T09:35:00.000Z");
	});

	it("auto rejects at max(created + 5 minutes, ETA - 15 minutes)", async () => {
		await insertOrder({ id: "minimum", createdAt: "2026-09-30T09:00:00.000Z", estimatedReadyAt: "2026-09-30T09:15:00.000Z" });
		await insertOrder({ id: "queued", createdAt: "2026-09-30T09:00:00.000Z", estimatedReadyAt: "2026-09-30T09:40:00.000Z" });

		expect((await processDueAutoRejections(env.DB, new Date("2026-09-30T09:04:59.000Z"))).rejectedOrderIds).toEqual([]);
		expect((await processDueAutoRejections(env.DB, new Date("2026-09-30T09:05:00.000Z"))).rejectedOrderIds).toEqual(["minimum"]);
		expect((await readOrder("minimum"))).toMatchObject({ status: "rejected", rejectionReason: "auto_rejected_unanswered" });
		expect((await processDueAutoRejections(env.DB, new Date("2026-09-30T09:24:59.000Z"))).rejectedOrderIds).toEqual([]);
		expect((await processDueAutoRejections(env.DB, new Date("2026-09-30T09:25:00.000Z"))).rejectedOrderIds).toEqual(["queued"]);
	});

	it("uses pending-state CAS so an accepted order cannot be auto rejected", async () => {
		await insertOrder({ id: "race", createdAt: "2026-09-30T09:00:00.000Z", estimatedReadyAt: "2026-09-30T09:15:00.000Z" });
		await env.DB.prepare("UPDATE store_settings SET missed_order_count = 2 WHERE id = 1").run();

		await transitionMerchantOrder(env.DB, "race", "accept", new Date("2026-09-30T09:05:00.000Z"));
		const result = await processDueAutoRejections(env.DB, new Date("2026-09-30T09:05:00.000Z"));
		const store = await env.DB.prepare("SELECT missed_order_count AS missed, is_accepting_orders AS accepting FROM store_settings WHERE id = 1").first<{ missed: number; accepting: number }>();

		expect(result.rejectedOrderIds).toEqual([]);
		expect((await readOrder("race"))?.status).toBe("accepted");
		expect(store).toEqual({ missed: 0, accepting: 1 });
	});

	it("counts each unanswered rejection once and pauses after three consecutive misses", async () => {
		for (const id of ["miss-1", "miss-2", "miss-3"]) {
			await insertOrder({ id, createdAt: "2026-09-30T09:00:00.000Z", estimatedReadyAt: "2026-09-30T09:15:00.000Z" });
		}

		const firstRun = await processDueAutoRejections(env.DB, new Date("2026-09-30T09:05:00.000Z"));
		const secondRun = await processDueAutoRejections(env.DB, new Date("2026-09-30T09:06:00.000Z"));
		const store = await env.DB.prepare(
			"SELECT missed_order_count AS missed, is_accepting_orders AS accepting, auto_pause_reason AS reason, state_version AS version FROM store_settings WHERE id = 1",
		).first<{ missed: number; accepting: number; reason: string | null; version: number }>();
		const events = await env.DB.prepare("SELECT COUNT(*) AS count FROM order_auto_rejection_events WHERE counted = 1").first<{ count: number }>();

		expect(firstRun.rejectedOrderIds).toEqual(["miss-1", "miss-2", "miss-3"]);
		expect(secondRun.rejectedOrderIds).toEqual([]);
		expect(events?.count).toBe(3);
		expect(store).toEqual({ missed: 3, accepting: 0, reason: "missed_orders", version: 3 });
	});
});
