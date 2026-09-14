import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/worker/index";

const headers = {
	"content-type": "application/json",
	Origin: "https://example.com",
	"Sec-Fetch-Site": "same-origin",
};

function operationId(sequence: number) {
	return `10000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

function postStore(
	action: "pause" | "resume",
	sequence: number,
	expectedIsAcceptingOrders: boolean,
	expectedStateVersion: number,
) {
	return exports.default.fetch(`https://example.com/api/merchant/store/${action}`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			operationId: operationId(sequence),
			expectedIsAcceptingOrders,
			expectedStateVersion,
		}),
	});
}

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM store_state_events"),
		env.DB.prepare(
			"UPDATE store_settings SET is_accepting_orders = 0, state_version = 0 WHERE id = 1",
		),
	]);
});

describe("Merchant Store operation API", () => {
	it("publishes only Store stateVersion on the public Store response", async () => {
		const response = await exports.default.fetch("https://example.com/api/store");
		const body = (await response.json()) as Record<string, unknown>;

		expect(response.status).toBe(200);
		expect(body).toMatchObject({ is_accepting_orders: false, stateVersion: 0 });
		expect(body).not.toHaveProperty("audit");
		expect(body).not.toHaveProperty("actor_subject_hash");
	});

	it("returns the fixed applied, replay, stale, and conflict statuses", async () => {
		const applied = await postStore("resume", 1, false, 0);
		const appliedBody = (await applied.json()) as Record<string, unknown>;
		const replay = await postStore("resume", 1, false, 0);
		const stale = await postStore("pause", 2, true, 0);
		const conflict = await exports.default.fetch(
			"https://example.com/api/merchant/store/pause",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					operationId: operationId(1),
					expectedIsAcceptingOrders: true,
					expectedStateVersion: 1,
				}),
			},
		);

		expect(applied.status).toBe(200);
		expect(appliedBody).toMatchObject({
			operationId: operationId(1),
			action: "resume",
			outcome: "APPLIED",
			store: { is_accepting_orders: true },
			stateVersion: 1,
		});
		expect(Object.keys(appliedBody).sort()).toEqual([
			"action",
			"createdAt",
			"operationId",
			"outcome",
			"stateVersion",
			"store",
		]);
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({ outcome: "IDEMPOTENT_REPLAY" });
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ outcome: "STALE_STATE" });
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({
			error: { code: "OPERATION_ID_CONFLICT" },
		});
	});

	it("rejects extra fields and action-incompatible expected state", async () => {
		const extra = await exports.default.fetch(
			"https://example.com/api/merchant/store/resume",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					operationId: operationId(3),
					expectedIsAcceptingOrders: false,
					expectedStateVersion: 0,
					action: "resume",
				}),
			},
		);
		const incompatible = await postStore("resume", 4, true, 0);

		expect(extra.status).toBe(400);
		expect(incompatible.status).toBe(400);
		expect(
			(await env.DB.prepare("SELECT COUNT(*) AS count FROM store_state_events").first<{
				count: number;
			}>())?.count,
		).toBe(0);
	});

	it("looks up a sanitized operation without mutation", async () => {
		await postStore("resume", 5, false, 0);
		const before = await env.DB.prepare("SELECT COUNT(*) AS count FROM store_state_events").first<{
			count: number;
		}>();
		const found = await exports.default.fetch(
			`https://example.com/api/merchant/store/operations/${operationId(5)}`,
		);
		const foundBody = (await found.json()) as Record<string, unknown>;
		const missing = await exports.default.fetch(
			`https://example.com/api/merchant/store/operations/${operationId(6)}`,
		);
		const invalid = await exports.default.fetch(
			"https://example.com/api/merchant/store/operations/not-a-uuid",
		);
		const after = await env.DB.prepare("SELECT COUNT(*) AS count FROM store_state_events").first<{
			count: number;
		}>();

		expect(found.status).toBe(200);
		expect(foundBody).toMatchObject({ operationId: operationId(5), outcome: "APPLIED" });
		expect(foundBody).not.toHaveProperty("actor_subject_hash");
		expect(foundBody).not.toHaveProperty("actorSubjectHash");
		expect(foundBody).not.toHaveProperty("request_fingerprint");
		expect(foundBody).not.toHaveProperty("requestFingerprint");
		expect(missing.status).toBe(404);
		expect(invalid.status).toBe(400);
		expect(after).toEqual(before);
	});

	it("fails closed when the actor hash binding is missing", async () => {
		const response = await app.request(
			new Request("https://example.com/api/merchant/store/resume", {
				method: "POST",
				headers,
				body: JSON.stringify({
					operationId: operationId(7),
					expectedIsAcceptingOrders: false,
					expectedStateVersion: 0,
				}),
			}),
			undefined,
			{
				DB: env.DB,
				MERCHANT_DEV_BYPASS: "true",
				MERCHANT_DEV_ACTOR_SUBJECT: "local-test-merchant-subject",
				MERCHANT_HOSTNAME: "example.com",
			} as unknown as Env,
			{} as ExecutionContext,
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
		expect(
			(await env.DB.prepare("SELECT COUNT(*) AS count FROM store_state_events").first<{
				count: number;
			}>())?.count,
		).toBe(0);
	});
});
