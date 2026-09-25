import { describe, expect, it } from "vitest";
import {
	hasRecoverableOrderAttempt,
	hashOrderAttemptRequest,
	ORDER_ATTEMPT_TTL_MS,
	restoreCheckoutFormDraft,
	restoreOrderAttempt,
	serializeCheckoutFormDraft,
	serializeOrderAttempt,
} from "../src/react-app/order-attempt";
import {
	CUSTOMER_PHONE_ERROR_MESSAGE,
	isValidCustomerPhone,
} from "../src/shared/customer-contact";

const request = {
	customerName: " 王小明 ",
	customerPhone: " 0912345678 ",
	customerNote: " 不要辣 ",
	packagingPreference: "together" as const,
	specialOrder: false,
	items: [
		{ menuItemId: 2, quantity: 1, modifierOptionIds: [30, 20] },
		{ menuItemId: 1, quantity: 2, modifierOptionIds: [10] },
	],
};

describe("pending Order attempt recovery", () => {
	it("accepts only a 09-prefixed 10-digit ASCII mobile number", () => {
		expect(isValidCustomerPhone("0912345678")).toBe(true);
		for (const invalidPhone of [
			"09123456",
			"09abcd5678",
			"",
			"   ",
			"0912345",
			"09123456789",
			"０９１２３４５６７８",
		]) {
			expect(isValidCustomerPhone(invalidPhone), invalidPhone).toBe(false);
		}
		expect(CUSTOMER_PHONE_ERROR_MESSAGE).toBe("請輸入 09 開頭的 10 位手機號碼");
	});

	it("hashes the same backend-canonical request identically", async () => {
		const first = await hashOrderAttemptRequest(request);
		const reordered = await hashOrderAttemptRequest({
			...request,
			customerName: "王小明",
			customerPhone: "0912345678",
			customerNote: "不要辣",
			items: [
				{ menuItemId: 1, quantity: 2, modifierOptionIds: [10] },
				{ menuItemId: 2, quantity: 1, modifierOptionIds: [20, 30] },
			],
		});

		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(reordered).toBe(first);
	});

	it("restores only the matching unexpired idempotency key", async () => {
		const requestHash = await hashOrderAttemptRequest(request);
		const stored = serializeOrderAttempt(requestHash, "attempt-key", 1_000);

		expect(restoreOrderAttempt(stored, requestHash, 2_000)).toBe("attempt-key");
		expect(restoreOrderAttempt(stored, "f".repeat(64), 2_000)).toBeNull();
		expect(
			restoreOrderAttempt(stored, requestHash, 1_000 + ORDER_ATTEMPT_TTL_MS + 1),
		).toBeNull();
		expect(hasRecoverableOrderAttempt(stored, 2_000)).toBe(true);
	});

	it("keeps the attempt identity stable when only the confirmed quote changes", async () => {
		const first = await hashOrderAttemptRequest({ ...request, quoteFingerprint: "a".repeat(64) });
		const refreshed = await hashOrderAttemptRequest({
			...request,
			quoteFingerprint: "b".repeat(64),
		});
		expect(refreshed).toBe(first);
	});

	it("stores no customer or cart plaintext", async () => {
		const requestHash = await hashOrderAttemptRequest(request);
		const stored = serializeOrderAttempt(requestHash, "attempt-key", 1_000);

		expect(stored).not.toContain("王小明");
		expect(stored).not.toContain("0912345678");
		expect(stored).not.toContain("不要辣");
		expect(stored).not.toContain("menuItemId");
	});

	it("restores checkout contact data only from the session-scoped draft contract", () => {
		const form = {
			customerName: "王小明",
			customerPhone: "0912345678",
			orderNote: "炸酥一點",
			packagingPreference: "together" as const,
			shortagePolicy: "continue_available" as const,
		};
		const stored = serializeCheckoutFormDraft(form, 1_000);

		expect(restoreCheckoutFormDraft(stored, 2_000)).toEqual(form);
		expect(
			restoreCheckoutFormDraft(stored, 1_000 + ORDER_ATTEMPT_TTL_MS + 1),
		).toBeNull();
	});
});
