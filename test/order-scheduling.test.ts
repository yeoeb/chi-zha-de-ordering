import { describe, expect, it } from "vitest";
import {
	createKitchenScheduleFingerprint,
	getOrderCapacityMinutes,
	planPendingOnsiteAdvances,
	scheduleNewOnsiteOrder,
	type KitchenScheduleOrder,
} from "../src/worker/order-scheduling";

const settings = {
	basePrepMinutes: 15,
	normalOrderMinutes: 5,
	specialExtraMinutes: 10,
};
const now = new Date("2026-09-25T04:00:00.000Z");

function scheduled(
	id: string,
	estimatedReadyAt: string,
	orderSource: "online" | "onsite" = "online",
	status: "pending" | "accepted" = "pending",
	specialOrder = false,
): KitchenScheduleOrder {
	return {
		id,
		status,
		orderSource,
		specialOrder,
		estimatedReadyAt,
		createdAt: "2026-09-25T03:50:00.000Z",
	};
}

describe("onsite kitchen scheduling", () => {
	it("uses five-minute capacity units from the existing preparation settings", () => {
		expect(getOrderCapacityMinutes(settings, false)).toBe(5);
		expect(getOrderCapacityMinutes(settings, true)).toBe(15);
	});

	it("does not place a new onsite order ahead of a reserved online deadline", () => {
		const readyAt = scheduleNewOnsiteOrder(
			[scheduled("online-a", "2026-09-25T04:20:00.000Z")],
			settings,
			false,
			now,
		);
		expect(readyAt).toBe("2026-09-25T04:25:00.000Z");
	});

	it("fills a verified capacity gap without moving online deadlines", () => {
		const orders = [
			scheduled("online-a", "2026-09-25T04:20:00.000Z"),
			scheduled("online-b", "2026-09-25T04:40:00.000Z"),
		];
		const readyAt = scheduleNewOnsiteOrder(orders, settings, false, now);
		expect(readyAt).toBe("2026-09-25T04:25:00.000Z");
		expect(orders.map((order) => order.estimatedReadyAt)).toEqual([
			"2026-09-25T04:20:00.000Z",
			"2026-09-25T04:40:00.000Z",
		]);
	});
	it("keeps new identifiers on five-minute boundaries around an unaligned legacy reservation", () => {
		expect(scheduleNewOnsiteOrder([scheduled("legacy", "2026-09-25T04:22:00.000Z")], settings, false, now)).toBe("2026-09-25T04:30:00.000Z");
	});

	it("queues after continuous reservations when no gap is large enough", () => {
		const readyAt = scheduleNewOnsiteOrder([
			scheduled("online-a", "2026-09-25T04:20:00.000Z"),
			scheduled("online-b", "2026-09-25T04:25:00.000Z"),
			scheduled("online-c", "2026-09-25T04:30:00.000Z"),
		], settings, false, now);
		expect(readyAt).toBe("2026-09-25T04:35:00.000Z");
	});

	it("advances only unstarted onsite orders after capacity is released", () => {
		const accepted = scheduled(
			"accepted-onsite",
			"2026-09-25T04:30:00.000Z",
			"onsite",
			"accepted",
		);
		const pending = scheduled(
			"pending-onsite",
			"2026-09-25T04:45:00.000Z",
			"onsite",
		);
		const updates = planPendingOnsiteAdvances(
			[accepted, pending, scheduled("online-b", "2026-09-25T04:40:00.000Z")],
			settings,
			new Date("2026-09-25T04:30:00.000Z"),
		);
		expect(updates).toEqual([{
			id: "pending-onsite",
			from: "2026-09-25T04:45:00.000Z",
			to: "2026-09-25T04:35:00.000Z",
		}]);
		expect(updates.some((update) => update.id === "accepted-onsite")).toBe(false);
	});

	it("re-evaluates a waiting onsite order into an early released gap", () => {
		const updates = planPendingOnsiteAdvances([
			scheduled("online-later", "2026-09-25T04:40:00.000Z"),
			scheduled("waiting-onsite", "2026-09-25T04:45:00.000Z", "onsite"),
		], settings, new Date("2026-09-25T04:20:00.000Z"));
		expect(updates).toEqual([{
			id: "waiting-onsite",
			from: "2026-09-25T04:45:00.000Z",
			to: "2026-09-25T04:25:00.000Z",
		}]);
	});

	it("builds a stable exact fingerprint for concurrency guards", () => {
		const first = scheduled("b", "2026-09-25T04:25:00.000Z", "onsite");
		const second = scheduled("a", "2026-09-25T04:20:00.000Z");
		expect(createKitchenScheduleFingerprint([first, second])).toBe(
			createKitchenScheduleFingerprint([second, first]),
		);
	});
});
