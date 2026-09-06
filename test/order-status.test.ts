import { describe, expect, it } from "vitest";
import { shouldPollOrderStatus, type OrderStatus } from "../src/react-app/order-status";

describe("Customer Order status polling", () => {
	it.each<[OrderStatus, boolean]>([
		["pending", true],
		["accepted", true],
		["completed", false],
		["rejected", false],
	])("returns %s polling decision", (status, expected) => {
		expect(shouldPollOrderStatus(status)).toBe(expected);
	});
});
