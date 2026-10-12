export const ORDER_ATTEMPT_STORAGE_KEY = "chi-zha-de:pending-order-attempt";
export const ORDER_ATTEMPT_VERSION = 1;
export const ORDER_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;
export const ORDER_FORM_SESSION_KEY = "chi-zha-de:checkout-form";
const ORDER_FORM_VERSION = 1;

type OrderAttemptRequest = {
	orderSource?: "online" | "onsite";
	customerPhone?: string;
	customerNote: string | null;
	packagingPreference: "together" | "separate_spicy";
	shortagePolicy?: "continue_available" | "cancel_entire_order";
	specialOrder: boolean;
	// A definitely rejected quote may be refreshed without changing the logical Order attempt.
	quoteFingerprint?: string;
	items: Array<{
		menuItemId: number;
		quantity: number;
		modifierOptionIds: number[];
	}>;
};

type StoredOrderAttempt = {
	version: typeof ORDER_ATTEMPT_VERSION;
	requestHash: string;
	idempotencyKey: string;
	updatedAt: number;
};

export type CheckoutFormDraft = {
	customerPhone: string;
	orderNote: string;
	packagingPreference: "together" | "separate_spicy";
	shortagePolicy?: "continue_available" | "cancel_entire_order";
};

function canonicalizeRequest(request: OrderAttemptRequest) {
	const items = request.items
		.map((item) => ({
			menuItemId: item.menuItemId,
			quantity: item.quantity,
			modifierOptionIds: [...item.modifierOptionIds].sort((left, right) => left - right),
		}))
		.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

	return JSON.stringify({
		...(request.orderSource === "onsite" ? { orderSource: "onsite" as const } : {}),
		customerPhone: request.customerPhone?.trim() ?? "",
		customerNote: request.customerNote?.trim() || null,
		packagingPreference: request.packagingPreference,
		shortagePolicy: request.shortagePolicy ?? "continue_available",
		specialOrder: request.specialOrder,
		items,
	});
}

export async function hashOrderAttemptRequest(request: OrderAttemptRequest) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonicalizeRequest(request)),
	);
	return [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

export function serializeOrderAttempt(
	requestHash: string,
	idempotencyKey: string,
	now = Date.now(),
) {
	return JSON.stringify({
		version: ORDER_ATTEMPT_VERSION,
		requestHash,
		idempotencyKey,
		updatedAt: now,
	} satisfies StoredOrderAttempt);
}

function parseStoredOrderAttempt(raw: string | null, now: number) {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	if (
		Object.keys(record).some(
			(key) => !["version", "requestHash", "idempotencyKey", "updatedAt"].includes(key),
		) ||
		record.version !== ORDER_ATTEMPT_VERSION ||
		typeof record.requestHash !== "string" ||
		!/^[0-9a-f]{64}$/.test(record.requestHash) ||
		typeof record.idempotencyKey !== "string" ||
		record.idempotencyKey.length === 0 ||
		record.idempotencyKey.length > 128 ||
		typeof record.updatedAt !== "number" ||
		!Number.isFinite(record.updatedAt) ||
		record.updatedAt > now + 60_000 ||
		now - record.updatedAt > ORDER_ATTEMPT_TTL_MS
	) {
		return null;
	}
	return record as StoredOrderAttempt;
}

export function hasRecoverableOrderAttempt(raw: string | null, now = Date.now()) {
	return parseStoredOrderAttempt(raw, now) !== null;
}

// Used only after the customer explicitly confirms a pending attempt. The
// original key is retained even if a stale client hash no longer matches.
// Backend fingerprint comparison remains authoritative; a committed different
// request conflicts rather than creating a second order.
export function restorePendingOrderAttemptKey(raw: string | null, now = Date.now()) {
	return parseStoredOrderAttempt(raw, now)?.idempotencyKey ?? null;
}

export function restoreOrderAttempt(
	raw: string | null,
	requestHash: string,
	now = Date.now(),
) {
	const record = parseStoredOrderAttempt(raw, now);
	return record?.requestHash === requestHash ? record.idempotencyKey : null;
}

export function serializeCheckoutFormDraft(draft: CheckoutFormDraft, now = Date.now()) {
	return JSON.stringify({ version: ORDER_FORM_VERSION, updatedAt: now, ...draft });
}

export function restoreCheckoutFormDraft(
	raw: string | null,
	now = Date.now(),
): CheckoutFormDraft | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	if (
		Object.keys(record).some(
			(key) => ![
				"version",
				"updatedAt",
				"customerPhone",
				"orderNote",
				"packagingPreference",
				"shortagePolicy",
			].includes(key),
		) ||
		record.version !== ORDER_FORM_VERSION ||
		typeof record.updatedAt !== "number" ||
		!Number.isFinite(record.updatedAt) ||
		record.updatedAt > now + 60_000 ||
		now - record.updatedAt > ORDER_ATTEMPT_TTL_MS ||
		typeof record.customerPhone !== "string" ||
		record.customerPhone.length > 30 ||
		typeof record.orderNote !== "string" ||
		[...record.orderNote].length > 120 ||
		(record.packagingPreference !== "together" &&
			record.packagingPreference !== "separate_spicy") ||
		(record.shortagePolicy !== undefined &&
			record.shortagePolicy !== "continue_available" &&
			record.shortagePolicy !== "cancel_entire_order")
	) {
		return null;
	}
	return {
		customerPhone: record.customerPhone,
		orderNote: record.orderNote,
		packagingPreference: record.packagingPreference,
		...(record.shortagePolicy === "continue_available" || record.shortagePolicy === "cancel_entire_order"
			? { shortagePolicy: record.shortagePolicy }
			: {}),
	};
}
