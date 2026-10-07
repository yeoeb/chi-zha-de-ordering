import { describe, expect, it } from "vitest";
import { isCustomerOrderActive, shouldPollOrderStatus, type OrderStatus } from "../src/react-app/order-status";

describe("Customer Order status polling", () => {
	it.each<[OrderStatus, boolean]>([
		["pending", true],
		["accepted", true],
		["completed", false],
		["rejected", false],
	])("returns %s polling decision", (status, expected) => {
		expect(shouldPollOrderStatus(status)).toBe(expected);
	});

	it("treats the pickup deadline as the active My Orders boundary", () => {
		const order = { status: "accepted" as const, estimatedReadyAt: "2026-09-16T10:20:00.000Z" };
		expect(isCustomerOrderActive(order, Date.parse(order.estimatedReadyAt) - 1)).toBe(true);
		expect(isCustomerOrderActive(order, Date.parse(order.estimatedReadyAt))).toBe(false);
		expect(isCustomerOrderActive(order, Date.parse(order.estimatedReadyAt) + 1)).toBe(false);
		expect(isCustomerOrderActive({ ...order, status: "completed" }, Date.parse(order.estimatedReadyAt) - 1)).toBe(false);
	});
});
