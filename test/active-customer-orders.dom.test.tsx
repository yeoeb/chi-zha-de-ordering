import { beforeEach, describe, expect, it } from "vitest";
import {
	ACTIVE_CUSTOMER_ORDER_STORAGE_KEY,
	CUSTOMER_ORDER_HISTORY_STORAGE_KEY,
	CUSTOMER_ORDER_UPDATE_STORAGE_KEY,
	acknowledgeShortageRevision,
	readActiveCustomerOrderTokens,
	readCustomerOrderHistoryTokens,
	readCustomerOrderUpdateTokens,
	rememberActiveCustomerOrder,
} from "../src/react-app/active-customer-orders";
import type { CustomerOrder } from "../src/react-app/order-status";

function order(token: string, status: CustomerOrder["status"]): CustomerOrder {
	return {
		publicLookupToken: token,
		orderNumber: "023",
		status,
		customerName: "王小明",
		customerNote: null,
		packagingPreference: "together",
		createdAt: "2026-09-16T10:00:00.000Z",
		estimatedReadyAt: "2026-09-16T10:20:00.000Z",
		total: 90,
		items: [],
	};
}

describe("active customer Order recovery", () => {
	beforeEach(() => localStorage.clear());

	it("stores multiple opaque lookup tokens without customer personal data", () => {
		const first = "a".repeat(64);
		const second = "b".repeat(64);
		rememberActiveCustomerOrder(order(first, "pending"));
		rememberActiveCustomerOrder(order(second, "accepted"));

		expect(readActiveCustomerOrderTokens()).toEqual([second, first]);
		const raw = localStorage.getItem(ACTIVE_CUSTOMER_ORDER_STORAGE_KEY) ?? "";
		expect(raw).not.toContain("王小明");
	});

	it("removes a completed or rejected Order without overwriting other active Orders", () => {
		const first = "a".repeat(64);
		const second = "b".repeat(64);
		rememberActiveCustomerOrder(order(first, "pending"));
		rememberActiveCustomerOrder(order(second, "pending"));
		rememberActiveCustomerOrder(order(second, "completed"));

		expect(readActiveCustomerOrderTokens()).toEqual([first]);
		expect(readCustomerOrderHistoryTokens()).toEqual([second]);
		expect(localStorage.getItem(CUSTOMER_ORDER_HISTORY_STORAGE_KEY)).not.toContain("王小明");
	});

	it("moves a still-active cross-date Order out of a stale history index", () => {
		const token = "d".repeat(64);
		rememberActiveCustomerOrder(order(token, "completed"));
		expect(readCustomerOrderHistoryTokens()).toEqual([token]);

		rememberActiveCustomerOrder({
			...order(token, "accepted"),
			createdAt: "2026-09-15T10:00:00.000Z",
		});

		expect(readActiveCustomerOrderTokens()).toEqual([token]);
		expect(readCustomerOrderHistoryTokens()).toEqual([]);
	});

	it("keeps only the latest twenty opaque history tokens", () => {
		for (let index = 0; index < 22; index += 1) {
			rememberActiveCustomerOrder(order(index.toString(16).padStart(64, "a").slice(-64), "completed"));
		}

		const tokens = readCustomerOrderHistoryTokens();
		expect(tokens).toHaveLength(20);
		expect(tokens[0]).toBe("a".repeat(62) + "15");
		expect(tokens).not.toContain("a".repeat(63) + "0");
	});

	it("persists only the opaque token for an unread shortage and clears it on acknowledgement", () => {
		const token = "c".repeat(64);
		rememberActiveCustomerOrder({
			...order(token, "cancelled"),
			shortageRevision: 2,
			shortages: [{ name: "雞排", quantity: 1, amountDeducted: 85 }],
		});

		expect(readCustomerOrderUpdateTokens()).toEqual([token]);
		const raw = localStorage.getItem(CUSTOMER_ORDER_UPDATE_STORAGE_KEY) ?? "";
		expect(raw).not.toContain("雞排");
		expect(raw).not.toContain("王小明");

		acknowledgeShortageRevision(token, 2);
		expect(readCustomerOrderUpdateTokens()).toEqual([]);
	});
});
