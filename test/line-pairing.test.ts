import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/worker/index";
import {
	createLinePairingChallenge,
	getLineMerchantRecipientId,
	processLineWebhook,
	type LinePairingBindings,
} from "../src/worker/line-pairing";
import type { NotificationBindings } from "../src/worker/notifications";
import type { SecurityBindings } from "../src/worker/security";

const channelSecret = "test-line-channel-secret";
const fixedNow = new Date("2026-09-09T02:00:00.000Z");
const firstUserId = `U${"a".repeat(32)}`;
const secondUserId = `U${"b".repeat(32)}`;

type TestBindings = Env & SecurityBindings & NotificationBindings & LinePairingBindings;

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM line_merchant_binding"),
		env.DB.prepare("DELETE FROM line_merchant_pairing_challenge"),
	]);
});

function deterministicBytes(values: number[]) {
	return () => Uint8Array.from(values);
}

async function signBody(rawBody: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(channelSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(rawBody),
	);
	return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function pairingPayload(code: string, userId = firstUserId, sourceType = "user", text?: string) {
	return {
		events: [
			{
				type: "message",
				source: { type: sourceType, userId },
				message: { type: "text", text: text ?? `綁定 ${code}` },
			},
		],
	};
}

async function postWebhook(rawBody: string, signature?: string) {
	return app.request(
		new Request("https://example.com/api/line/webhook", {
			method: "POST",
			headers: signature ? { "x-line-signature": signature } : undefined,
			body: rawBody,
		}),
		undefined,
		{ DB: env.DB, LINE_CHANNEL_SECRET: channelSecret } as TestBindings,
		{} as ExecutionContext,
	);
}

async function createFixedChallenge(values = [0, 1, 2, 3, 4, 5, 6, 7]) {
	return createLinePairingChallenge(env.DB, fixedNow, deterministicBytes(values));
}

describe("LINE webhook signature boundary", () => {
	it("accepts a valid signed empty verification webhook", async () => {
		const rawBody = JSON.stringify({ events: [] });
		const response = await postWebhook(rawBody, await signBody(rawBody));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it("rejects a missing signature", async () => {
		const response = await postWebhook(JSON.stringify({ events: [] }));

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			error: { code: "LINE_WEBHOOK_SIGNATURE_REQUIRED" },
		});
	});

	it("rejects an invalid signature before attempting to parse malformed JSON", async () => {
		const response = await postWebhook("{", "not-a-valid-signature");

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			error: { code: "INVALID_LINE_WEBHOOK_SIGNATURE" },
		});
	});

	it("rejects malformed JSON only after a valid signature", async () => {
		const rawBody = "{";
		const response = await postWebhook(rawBody, await signBody(rawBody));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "INVALID_LINE_WEBHOOK_BODY" },
		});
	});
});

describe("Merchant LINE pairing API", () => {
	it("fails closed when an unauthenticated caller creates a challenge", async () => {
		const response = await app.request(
			new Request("https://merchant.example.com/api/merchant/line/pairing", {
				method: "POST",
			}),
			undefined,
			{
				DB: env.DB,
				LINE_CHANNEL_SECRET: channelSecret,
				MERCHANT_HOSTNAME: "merchant.example.com",
			} as TestBindings,
			{} as ExecutionContext,
		);

		expect(response.status).toBe(403);
	});

	it("returns plaintext once while storing only its hash with a ten-minute TTL", async () => {
		const challenge = await createFixedChallenge();
		const stored = await env.DB
			.prepare(
				`SELECT code_hash AS codeHash, expires_at AS expiresAt, consumed_at AS consumedAt
				FROM line_merchant_pairing_challenge WHERE id = 1`,
			)
			.first<{ codeHash: string; expiresAt: string; consumedAt: string | null }>();

		expect(challenge.code).toBe("ABCD-EFGH");
		expect(challenge.expiresAt).toBe("2026-09-09T02:10:00.000Z");
		expect(stored?.codeHash).toMatch(/^[0-9a-f]{64}$/);
		expect(stored?.codeHash).not.toContain(challenge.code);
		expect(stored).toMatchObject({ expiresAt: challenge.expiresAt, consumedAt: null });
	});

	it("allows an authenticated Merchant to create one challenge", async () => {
		const response = await app.request(
			new Request("https://example.com/api/merchant/line/pairing", { method: "POST" }),
			undefined,
			{
				DB: env.DB,
				LINE_CHANNEL_SECRET: channelSecret,
				MERCHANT_DEV_BYPASS: "true",
			} as TestBindings,
			{} as ExecutionContext,
		);
		const body = (await response.json()) as { code: string; expiresAt: string };

		expect(response.status).toBe(201);
		expect(body.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
		expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
		const stored = await env.DB
			.prepare("SELECT code_hash AS codeHash FROM line_merchant_pairing_challenge WHERE id = 1")
			.first<{ codeHash: string }>();
		expect(stored?.codeHash).not.toBe(body.code);
	});

	it("invalidates the previous challenge when generating another", async () => {
		const first = await createFixedChallenge();
		const second = await createFixedChallenge([8, 9, 10, 11, 12, 13, 14, 15]);
		const firstBody = JSON.stringify(pairingPayload(first.code));
		const firstResult = await processLineWebhook(
			env.DB,
			new TextEncoder().encode(firstBody),
			await signBody(firstBody),
			channelSecret,
			fixedNow,
		);

		expect(first.code).not.toBe(second.code);
		expect(firstResult).toEqual({ paired: false });
		expect(await getLineMerchantRecipientId(env.DB)).toBeNull();
	});
});

describe("LINE pairing webhook", () => {
	it("binds a valid user with the correct one-time code and hides the user ID from status", async () => {
		const challenge = await createFixedChallenge();
		const rawBody = JSON.stringify(pairingPayload(challenge.code));
		const result = await processLineWebhook(
			env.DB,
			new TextEncoder().encode(rawBody),
			await signBody(rawBody),
			channelSecret,
			fixedNow,
		);

		expect(result).toEqual({ paired: true });
		expect(await getLineMerchantRecipientId(env.DB)).toBe(firstUserId);

		const statusResponse = await app.request(
			new Request("https://example.com/api/merchant/line/status"),
			undefined,
			{ DB: env.DB, MERCHANT_DEV_BYPASS: "true" } as TestBindings,
			{} as ExecutionContext,
		);
		const statusText = await statusResponse.text();
		expect(statusResponse.status).toBe(200);
		expect(JSON.parse(statusText)).toEqual({ paired: true, pairedAt: fixedNow.toISOString() });
		expect(statusText).not.toContain(firstUserId);
	});

	it("does not bind a wrong or expired code", async () => {
		const challenge = await createFixedChallenge();
		const wrongBody = JSON.stringify(pairingPayload("ZZZZ-9999"));
		await processLineWebhook(
			env.DB,
			new TextEncoder().encode(wrongBody),
			await signBody(wrongBody),
			channelSecret,
			fixedNow,
		);
		expect(await getLineMerchantRecipientId(env.DB)).toBeNull();

		const expiredBody = JSON.stringify(pairingPayload(challenge.code));
		await processLineWebhook(
			env.DB,
			new TextEncoder().encode(expiredBody),
			await signBody(expiredBody),
			channelSecret,
			new Date("2026-09-09T02:10:00.000Z"),
		);
		expect(await getLineMerchantRecipientId(env.DB)).toBeNull();
	});

	it("makes a consumed-code replay harmless", async () => {
		const challenge = await createFixedChallenge();
		const rawBody = JSON.stringify(pairingPayload(challenge.code));
		const signature = await signBody(rawBody);

		expect(
			await processLineWebhook(
				env.DB,
				new TextEncoder().encode(rawBody),
				signature,
				channelSecret,
				fixedNow,
			),
		).toEqual({ paired: true });
		expect(
			await processLineWebhook(
				env.DB,
				new TextEncoder().encode(rawBody),
				signature,
				channelSecret,
				new Date(fixedNow.getTime() + 1_000),
			),
		).toEqual({ paired: false });
		expect(await getLineMerchantRecipientId(env.DB)).toBe(firstUserId);
	});

	it("ignores non-user sources, malformed user IDs, and arbitrary messages", async () => {
		const challenge = await createFixedChallenge();
		const payload = {
			events: [
				pairingPayload(challenge.code, firstUserId, "group").events[0],
				pairingPayload(challenge.code, "not-a-line-user").events[0],
				pairingPayload(challenge.code, firstUserId, "user", "hello").events[0],
			],
		};
		const rawBody = JSON.stringify(payload);
		const response = await postWebhook(rawBody, await signBody(rawBody));

		expect(response.status).toBe(200);
		expect(await getLineMerchantRecipientId(env.DB)).toBeNull();
	});

	it("requires a fresh Merchant challenge before replacing an existing recipient", async () => {
		const firstChallenge = await createFixedChallenge();
		const firstBody = JSON.stringify(pairingPayload(firstChallenge.code, firstUserId));
		await processLineWebhook(
			env.DB,
			new TextEncoder().encode(firstBody),
			await signBody(firstBody),
			channelSecret,
			fixedNow,
		);

		const replayBody = JSON.stringify(pairingPayload(firstChallenge.code, secondUserId));
		await processLineWebhook(
			env.DB,
			new TextEncoder().encode(replayBody),
			await signBody(replayBody),
			channelSecret,
			new Date(fixedNow.getTime() + 1_000),
		);
		expect(await getLineMerchantRecipientId(env.DB)).toBe(firstUserId);

		const secondChallenge = await createLinePairingChallenge(
			env.DB,
			new Date(fixedNow.getTime() + 2_000),
			deterministicBytes([8, 9, 10, 11, 12, 13, 14, 15]),
		);
		const secondBody = JSON.stringify(pairingPayload(secondChallenge.code, secondUserId));
		await processLineWebhook(
			env.DB,
			new TextEncoder().encode(secondBody),
			await signBody(secondBody),
			channelSecret,
			new Date(fixedNow.getTime() + 3_000),
		);
		expect(await getLineMerchantRecipientId(env.DB)).toBe(secondUserId);
	});

	it("does not expose the bound user ID through public Store or Menu APIs", async () => {
		await env.DB.prepare(
			`INSERT INTO line_merchant_binding (id, recipient_user_id, paired_at, updated_at)
			VALUES (1, ?, ?, ?)`,
		)
			.bind(firstUserId, fixedNow.toISOString(), fixedNow.toISOString())
			.run();

		for (const path of ["/api/store", "/api/menu"]) {
			const response = await app.request(
				new Request(`https://example.com${path}`),
				undefined,
				{ DB: env.DB } as TestBindings,
				{} as ExecutionContext,
			);
			expect(response.status).toBe(200);
			expect(await response.text()).not.toContain(firstUserId);
		}
	});
});
