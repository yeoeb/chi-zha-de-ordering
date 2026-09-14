import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
	getStoreOperationResult,
	parseStoreOperationRequest,
	performStoreOperation,
	StoreOperationError,
	type StoreAction,
} from "../src/worker/store-operations";

const auditKey = "local-test-audit-key-32-bytes-minimum";
const actorSubject = "opaque-access-subject";
const fixedNow = new Date("2026-09-14T01:00:00.000Z");

function operationId(sequence: number) {
	return `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

function operate(
	action: StoreAction,
	sequence: number,
	expectedIsAcceptingOrders: boolean,
	expectedStateVersion: number,
) {
	return performStoreOperation({
		db: env.DB,
		action,
		request: {
			operationId: operationId(sequence),
			expectedIsAcceptingOrders,
			expectedStateVersion,
		},
		actorSubject,
		auditActorHashKey: auditKey,
		cfRay: "test-ray",
		workerVersion: "test-worker-version",
		now: fixedNow,
	});
}

async function storeState() {
	return env.DB.prepare(
		"SELECT is_accepting_orders, state_version FROM store_settings WHERE id = 1",
	).first<{ is_accepting_orders: number; state_version: number }>();
}

async function eventCount() {
	return (
		(await env.DB.prepare("SELECT COUNT(*) AS count FROM store_state_events").first<{
			count: number;
		}>())?.count ?? -1
	);
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DROP TRIGGER IF EXISTS test_fail_store_audit"),
		env.DB.prepare("DROP TRIGGER IF EXISTS test_fail_store_update"),
		env.DB.prepare("DELETE FROM store_state_events"),
		env.DB.prepare(
			"UPDATE store_settings SET is_accepting_orders = 0, state_version = 0 WHERE id = 1",
		),
	]);
});

describe("Store operation request validation", () => {
	it("accepts only an exact canonical request for the endpoint action", () => {
		expect(
			parseStoreOperationRequest(
				{
					operationId: operationId(1),
					expectedIsAcceptingOrders: false,
					expectedStateVersion: 0,
				},
				"resume",
			),
		).toEqual({
			operationId: operationId(1),
			expectedIsAcceptingOrders: false,
			expectedStateVersion: 0,
		});
		expect(
			parseStoreOperationRequest(
				{
					operationId: operationId(2),
					expectedIsAcceptingOrders: false,
					expectedStateVersion: Number.MAX_SAFE_INTEGER,
				},
				"resume",
			),
		).toMatchObject({ expectedStateVersion: Number.MAX_SAFE_INTEGER });

		for (const body of [
			{},
			{ operationId: operationId(1), expectedIsAcceptingOrders: false, expectedStateVersion: 0, extra: true },
			{
				operationId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
				expectedIsAcceptingOrders: false,
				expectedStateVersion: 0,
			},
			{ operationId: operationId(1), expectedIsAcceptingOrders: true, expectedStateVersion: 0 },
			{ operationId: operationId(1), expectedIsAcceptingOrders: false, expectedStateVersion: -1 },
			{ operationId: operationId(1), expectedIsAcceptingOrders: false, expectedStateVersion: 0.5 },
			{ operationId: operationId(1), expectedIsAcceptingOrders: false, expectedStateVersion: "0" },
			{
				operationId: operationId(1),
				expectedIsAcceptingOrders: false,
				expectedStateVersion: Number.MAX_SAFE_INTEGER + 1,
			},
		]) {
			expect(() => parseStoreOperationRequest(body, "resume")).toThrow(StoreOperationError);
		}
	});
});

describe("Store CAS and immutable audit", () => {
	it("applies Resume false to true exactly once", async () => {
		const result = await operate("resume", 1, false, 0);
		const event = await env.DB.prepare(
			`SELECT action, from_accepting, to_accepting, from_state_version,
				to_state_version, outcome, actor_subject_hash, cf_ray, worker_version
			FROM store_state_events`,
		).first<Record<string, unknown>>();

		expect(result).toMatchObject({ outcome: "APPLIED", stateVersion: 1, store: { is_accepting_orders: true } });
		expect(await storeState()).toEqual({ is_accepting_orders: 1, state_version: 1 });
		expect(event).toMatchObject({
			action: "resume",
			from_accepting: 0,
			to_accepting: 1,
			from_state_version: 0,
			to_state_version: 1,
			outcome: "applied",
			cf_ray: "test-ray",
			worker_version: "test-worker-version",
		});
		expect(event?.actor_subject_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(event)).not.toContain(actorSubject);
	});

	it("records Resume already-target without changing state or version", async () => {
		await env.DB.prepare(
			"UPDATE store_settings SET is_accepting_orders = 1, state_version = 4 WHERE id = 1",
		).run();
		const result = await operate("resume", 2, false, 3);
		expect(result).toMatchObject({ outcome: "ALREADY_IN_TARGET_STATE", stateVersion: 4 });
		expect(await storeState()).toEqual({ is_accepting_orders: 1, state_version: 4 });
		expect(await eventCount()).toBe(1);
	});

	it("applies Pause true to false and makes repeated Pause safe", async () => {
		await env.DB.prepare(
			"UPDATE store_settings SET is_accepting_orders = 1, state_version = 7 WHERE id = 1",
		).run();
		const applied = await operate("pause", 3, true, 7);
		const already = await operate("pause", 4, true, 7);
		expect(applied).toMatchObject({ outcome: "APPLIED", stateVersion: 8 });
		expect(already).toMatchObject({ outcome: "ALREADY_IN_TARGET_STATE", stateVersion: 8 });
		expect(await storeState()).toEqual({ is_accepting_orders: 0, state_version: 8 });
	});

	it("replays the same fingerprint and rejects conflicting operation ID reuse", async () => {
		const first = await operate("resume", 5, false, 0);
		const replay = await operate("resume", 5, false, 0);
		expect(first.outcome).toBe("APPLIED");
		expect(replay.outcome).toBe("IDEMPOTENT_REPLAY");
		expect(await eventCount()).toBe(1);

		await expect(operate("pause", 5, true, 1)).rejects.toMatchObject({
			status: 409,
			code: "OPERATION_ID_CONFLICT",
		});
		expect(await eventCount()).toBe(1);
	});

	it("keeps historical operation state separate from the current authoritative Store", async () => {
		const resume = await operate("resume", 16, false, 0);
		const pause = await operate("pause", 17, true, 1);
		const replay = await operate("resume", 16, false, 0);
		const lookup = await getStoreOperationResult(env.DB, operationId(16));

		expect(resume).toMatchObject({ outcome: "APPLIED", stateVersion: 1 });
		expect(pause).toMatchObject({ outcome: "APPLIED", stateVersion: 2 });
		for (const result of [replay, lookup]) {
			expect(result).toMatchObject({
				store: { is_accepting_orders: false },
				stateVersion: 2,
				operation: {
					outcome: "APPLIED",
					store: { is_accepting_orders: true },
					stateVersion: 1,
				},
			});
		}
		expect(replay.outcome).toBe("IDEMPOTENT_REPLAY");
		expect(await eventCount()).toBe(2);
	});

	it("allows only one concurrent Resume and one concurrent Pause to apply", async () => {
		const resumes = await Promise.all([
			operate("resume", 6, false, 0),
			operate("resume", 7, false, 0),
		]);
		expect(resumes.filter((result) => result.outcome === "APPLIED")).toHaveLength(1);
		expect(await storeState()).toEqual({ is_accepting_orders: 1, state_version: 1 });

		const pauses = await Promise.all([
			operate("pause", 8, true, 1),
			operate("pause", 9, true, 1),
		]);
		expect(pauses.filter((result) => result.outcome === "APPLIED")).toHaveLength(1);
		expect(await storeState()).toEqual({ is_accepting_orders: 0, state_version: 2 });
	});

	it("records stale version and stale boolean without changing Store", async () => {
		await env.DB.prepare("UPDATE store_settings SET state_version = 2 WHERE id = 1").run();
		const staleVersion = await operate("resume", 10, false, 1);
		const staleBoolean = await operate("resume", 11, true, 2);
		expect(staleVersion.outcome).toBe("STALE_STATE");
		expect(staleBoolean.outcome).toBe("STALE_STATE");
		expect(await storeState()).toEqual({ is_accepting_orders: 0, state_version: 2 });
	});

	it("rolls back Store update when audit insert fails", async () => {
		await env.DB.prepare(
			`CREATE TRIGGER test_fail_store_audit
			BEFORE INSERT ON store_state_events
			BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`,
		).run();
		await expect(operate("resume", 12, false, 0)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
		expect(await storeState()).toEqual({ is_accepting_orders: 0, state_version: 0 });
		expect(await eventCount()).toBe(0);
	});

	it("rolls back applied audit event when Store update fails", async () => {
		await env.DB.prepare(
			`CREATE TRIGGER test_fail_store_update
			BEFORE UPDATE OF is_accepting_orders ON store_settings
			BEGIN SELECT RAISE(ABORT, 'forced store failure'); END`,
		).run();
		await expect(operate("resume", 13, false, 0)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
		expect(await storeState()).toEqual({ is_accepting_orders: 0, state_version: 0 });
		expect(await eventCount()).toBe(0);
	});

	it("fails closed before D1 when the actor hash key is missing", async () => {
		await expect(
			performStoreOperation({
				db: env.DB,
				action: "resume",
				request: {
					operationId: operationId(14),
					expectedIsAcceptingOrders: false,
					expectedStateVersion: 0,
				},
				actorSubject,
			}),
		).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
		expect(await eventCount()).toBe(0);
	});

	it("fails closed without an event when the Store version cannot be incremented safely", async () => {
		await env.DB.prepare("UPDATE store_settings SET state_version = ? WHERE id = 1")
			.bind(Number.MAX_SAFE_INTEGER)
			.run();

		await expect(
			operate("resume", 18, false, Number.MAX_SAFE_INTEGER),
		).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
		expect(await storeState()).toEqual({
			is_accepting_orders: 0,
			state_version: Number.MAX_SAFE_INTEGER,
		});
		expect(await eventCount()).toBe(0);
	});

	it("returns only a sanitized read-only operation result", async () => {
		await operate("resume", 15, false, 0);
		const result = await getStoreOperationResult(env.DB, operationId(15));
		expect(result).toMatchObject({ operationId: operationId(15), outcome: "APPLIED" });
		expect(result).not.toHaveProperty("actorSubjectHash");
		expect(result).not.toHaveProperty("requestFingerprint");
		expect(await eventCount()).toBe(1);
	});
});
