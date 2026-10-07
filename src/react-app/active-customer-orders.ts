import type { CustomerOrder } from "./order-status";
import { isCustomerOrderActive } from "./order-status";

export const ACTIVE_CUSTOMER_ORDER_STORAGE_KEY = "customer-active-order-tokens-v1";
export const CUSTOMER_ORDER_HISTORY_STORAGE_KEY = "customer-order-history-tokens-v1";
export const CUSTOMER_SHORTAGE_ACK_STORAGE_KEY = "customer-shortage-ack-v1";
export const CUSTOMER_ORDER_UPDATE_STORAGE_KEY = "customer-order-update-tokens-v1";
const MAX_STORED_ACTIVE_ORDERS = 10;
const MAX_STORED_HISTORY_ORDERS = 20;
const LOOKUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

function normalizeTokens(value: unknown, limit = MAX_STORED_ACTIVE_ORDERS) {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter(
		(token): token is string => typeof token === "string" && LOOKUP_TOKEN_PATTERN.test(token),
	))].slice(0, limit);
}

export function readActiveCustomerOrderTokens(storage: Storage = localStorage) {
	try {
		return normalizeTokens(JSON.parse(storage.getItem(ACTIVE_CUSTOMER_ORDER_STORAGE_KEY) ?? "[]"));
	} catch {
		return [];
	}
}

export function writeActiveCustomerOrderTokens(tokens: readonly string[], storage: Storage = localStorage) {
	const normalized = normalizeTokens(tokens);
	if (normalized.length === 0) storage.removeItem(ACTIVE_CUSTOMER_ORDER_STORAGE_KEY);
	else storage.setItem(ACTIVE_CUSTOMER_ORDER_STORAGE_KEY, JSON.stringify(normalized));
}

export function readCustomerOrderHistoryTokens(storage: Storage = localStorage) {
	try {
		return normalizeTokens(
			JSON.parse(storage.getItem(CUSTOMER_ORDER_HISTORY_STORAGE_KEY) ?? "[]"),
			MAX_STORED_HISTORY_ORDERS,
		);
	} catch {
		return [];
	}
}

export function writeCustomerOrderHistoryTokens(tokens: readonly string[], storage: Storage = localStorage) {
	const normalized = normalizeTokens(tokens, MAX_STORED_HISTORY_ORDERS);
	if (normalized.length === 0) storage.removeItem(CUSTOMER_ORDER_HISTORY_STORAGE_KEY);
	else storage.setItem(CUSTOMER_ORDER_HISTORY_STORAGE_KEY, JSON.stringify(normalized));
}

export function readCustomerOrderUpdateTokens(storage: Storage = localStorage) {
	try {
		return normalizeTokens(
			JSON.parse(storage.getItem(CUSTOMER_ORDER_UPDATE_STORAGE_KEY) ?? "[]"),
			MAX_STORED_HISTORY_ORDERS,
		);
	} catch {
		return [];
	}
}

function writeCustomerOrderUpdateTokens(tokens: readonly string[], storage: Storage) {
	const normalized = normalizeTokens(tokens, MAX_STORED_HISTORY_ORDERS);
	if (normalized.length === 0) storage.removeItem(CUSTOMER_ORDER_UPDATE_STORAGE_KEY);
	else storage.setItem(CUSTOMER_ORDER_UPDATE_STORAGE_KEY, JSON.stringify(normalized));
}

function rememberHistoryToken(token: string, storage: Storage) {
	writeCustomerOrderHistoryTokens([
		token,
		...readCustomerOrderHistoryTokens(storage).filter((candidate) => candidate !== token),
	], storage);
}

export function rememberActiveCustomerOrder(
	order: CustomerOrder,
	storage: Storage = localStorage,
	now = Date.now(),
) {
	const current = readActiveCustomerOrderTokens(storage).filter(
		(token) => token !== order.publicLookupToken,
	);
	const isActive = isCustomerOrderActive(order, now);
	writeActiveCustomerOrderTokens(
		isActive
			? [order.publicLookupToken, ...current]
			: current,
		storage,
	);
	if (isActive) {
		writeCustomerOrderHistoryTokens(
			readCustomerOrderHistoryTokens(storage).filter((token) => token !== order.publicLookupToken),
			storage,
		);
	} else {
		rememberHistoryToken(order.publicLookupToken, storage);
	}
	const updateTokens = readCustomerOrderUpdateTokens(storage).filter(
		(token) => token !== order.publicLookupToken,
	);
	if (
		(order.shortages?.length ?? 0) > 0 &&
		(order.shortageRevision ?? 0) > readAcknowledgedShortageRevision(order.publicLookupToken, storage)
	) {
		writeCustomerOrderUpdateTokens([order.publicLookupToken, ...updateTokens], storage);
	} else {
		writeCustomerOrderUpdateTokens(updateTokens, storage);
	}
}

export function readAcknowledgedShortageRevision(token: string, storage: Storage = localStorage) {
	try {
		const value = JSON.parse(storage.getItem(CUSTOMER_SHORTAGE_ACK_STORAGE_KEY) ?? "{}");
		if (typeof value !== "object" || value === null || Array.isArray(value)) return 0;
		const revision = (value as Record<string, unknown>)[token];
		return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
	} catch {
		return 0;
	}
}

export function acknowledgeShortageRevision(token: string, revision: number, storage: Storage = localStorage) {
	let current: Record<string, number> = {};
	try {
		const parsed = JSON.parse(storage.getItem(CUSTOMER_SHORTAGE_ACK_STORAGE_KEY) ?? "{}");
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			current = Object.fromEntries(Object.entries(parsed).filter(([, value]) =>
				typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
			)) as Record<string, number>;
		}
	} catch {
		// Replace malformed acknowledgement data with the current safe entry.
	}
	storage.setItem(CUSTOMER_SHORTAGE_ACK_STORAGE_KEY, JSON.stringify({ ...current, [token]: revision }));
	writeCustomerOrderUpdateTokens(
		readCustomerOrderUpdateTokens(storage).filter((candidate) => candidate !== token),
		storage,
	);
}
