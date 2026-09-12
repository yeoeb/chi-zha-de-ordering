import { describe, expect, it } from "vitest";
import { findNewPendingOrderIds } from "../src/react-app/merchant-polling";

describe("Merchant Order polling discovery", () => {
	it("seeds the seen set without alerting on the initial load", () => {
		expect(
			findNewPendingOrderIds(new Set(), [{ id: "existing", status: "pending" }], false),
		).toEqual([]);
	});

	it("alerts once only for newly discovered pending IDs", () => {
		const seen = new Set(["existing"]);
		const orders = [
			{ id: "existing", status: "pending" as const },
			{ id: "new", status: "pending" as const },
			{ id: "accepted", status: "accepted" as const },
		];
		expect(findNewPendingOrderIds(seen, orders, true)).toEqual(["new"]);
		seen.add("new");
		expect(findNewPendingOrderIds(seen, orders, true)).toEqual([]);
	});
});
