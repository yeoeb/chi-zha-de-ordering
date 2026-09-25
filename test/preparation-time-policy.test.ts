import { describe, expect, it } from "vitest";
import {
	getPreparationTimeEstimate,
	roundPreparationDurationMinutes,
} from "../src/worker/preparation-time-policy";

const now = new Date("2026-09-06T04:00:00.000Z");
const settings = {
	basePrepMinutes: 15,
	normalOrderMinutes: 5,
	specialExtraMinutes: 10,
};

describe("PreparationTimePolicy", () => {
	it.each([
		{ ordersAhead: 0, specialOrdersAhead: 0, expected: 20 },
		{ ordersAhead: 2, specialOrdersAhead: 0, expected: 30 },
		{ ordersAhead: 3, specialOrdersAhead: 1, expected: 45 },
	])(
		"returns $expected minutes for $ordersAhead orders with $specialOrdersAhead special",
		({ ordersAhead, specialOrdersAhead, expected }) => {
			expect(
				getPreparationTimeEstimate(
					{ ...settings, ordersAhead, specialOrdersAhead },
					now,
				).leadMinutes,
			).toBe(expected);
		},
	);

	it("rejects special queue counts greater than the total queue", () => {
		expect(() =>
			getPreparationTimeEstimate(
				{ ...settings, ordersAhead: 1, specialOrdersAhead: 2 },
				now,
			),
		).toThrow("specialOrdersAhead must not exceed ordersAhead");
	});

	it("never returns less than the base preparation time", () => {
		const estimate = getPreparationTimeEstimate(
			{
				basePrepMinutes: 15,
				normalOrderMinutes: 0,
				specialExtraMinutes: 0,
				ordersAhead: 10,
				specialOrdersAhead: 5,
			},
			now,
		);

		expect(estimate.leadMinutes).toBe(20);
	});

	it("derives an absolute UTC timestamp from the supplied clock", () => {
		const estimate = getPreparationTimeEstimate(
			{ ...settings, ordersAhead: 2, specialOrdersAhead: 0 },
			now,
		);

		expect(estimate.estimatedReadyAt).toBe("2026-09-06T04:30:00.000Z");
	});

	it.each([
		[5, 10],
		[12, 20],
		[15, 20],
	])("adds the buffer and rounds %i raw minutes to %i", (raw, expected) => {
		expect(roundPreparationDurationMinutes(raw)).toBe(expected);
	});

	it("rounds the final instant up to a five-minute clock boundary", () => {
		const estimate = getPreparationTimeEstimate(
			{ basePrepMinutes: 12, normalOrderMinutes: 0, specialExtraMinutes: 0, ordersAhead: 0, specialOrdersAhead: 0 },
			new Date("2026-09-06T10:03:27.500Z"),
		);
		expect(estimate.leadMinutes).toBe(20);
		expect(estimate.estimatedReadyAt).toBe("2026-09-06T10:25:00.000Z");
	});

	it("rounds safely across the next day without depending on the display timezone", () => {
		const estimate = getPreparationTimeEstimate(
			{ basePrepMinutes: 5, normalOrderMinutes: 0, specialExtraMinutes: 0, ordersAhead: 0, specialOrdersAhead: 0 },
			new Date("2026-09-06T23:53:59.999Z"),
		);
		expect(estimate.estimatedReadyAt).toBe("2026-09-07T00:05:00.000Z");
	});
});
