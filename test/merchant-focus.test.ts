import { describe, expect, it } from "vitest";
import { MerchantDeadlineEvents, selectMerchantFocus } from "../src/react-app/merchant-focus";

const now = Date.parse("2026-10-07T10:00:00Z");
const accepted = (minutes: number) => ({ id: "a", status: "accepted", estimatedReadyAt: new Date(now + minutes * 60_000).toISOString() });
describe("Merchant presentation events", () => {
	it("fires once at 11 → 9 minutes, not at 8 or 7", () => {
		const events = new MerchantDeadlineEvents();
		expect(events.observe([accepted(11)], now)).toEqual([]);
		expect(events.observe([accepted(11)], now + 2 * 60_000)).toEqual(["a"]);
		expect(events.observe([accepted(11)], now + 3 * 60_000)).toEqual([]);
		expect(events.observe([accepted(11)], now + 4 * 60_000)).toEqual([]);
	});
	it("seeds initial due orders and rearms only for a changed authoritative deadline", () => {
		const events = new MerchantDeadlineEvents();
		expect(events.observe([accepted(9)], now)).toEqual([]);
		expect(events.observe([accepted(9)], now + 60_000)).toEqual([]);
		expect(events.observe([accepted(20)], now + 60_000)).toEqual([]);
		expect(events.observe([accepted(20)], now + 11 * 60_000)).toEqual(["a"]);
		expect(events.observe([accepted(20)], now + 12 * 60_000)).toEqual([]);
	});
	it("ignores pending, scheduled, invalid timestamps and prunes terminal records", () => {
		const events = new MerchantDeadlineEvents();
		events.observe([], now);
		expect(events.observe([{ ...accepted(9), status: "scheduled" }, { ...accepted(9), status: "pending" }, { ...accepted(9), estimatedReadyAt: "invalid" }], now)).toEqual([]);
		expect(events.observe([accepted(9)], now)).toEqual(["a"]);
		events.observe([{ ...accepted(9), status: "completed" }], now);
		expect(events.observe([accepted(9)], now)).toEqual(["a"]);
	});
	it("handles a resume that crosses the deadline, not only the ten-minute window", () => {
		const events = new MerchantDeadlineEvents();
		events.observe([accepted(11)], now);
		expect(events.observe([accepted(11)], now + 12 * 60_000)).toEqual(["a"]);
	});
	it("prioritizes new pending over deadline over fallback, including sold-out", () => {
		const base = { pending: 1, accepted: 1, allowFallback: false };
		expect(selectMerchantFocus({ ...base, newPending: ["p"], deadlines: ["a"] })).toBe("pending");
		expect(selectMerchantFocus({ ...base, newPending: [], deadlines: ["a"] })).toBe("accepted");
		expect(selectMerchantFocus({ ...base, newPending: [], deadlines: [] })).toBeNull();
	});
	it.each([[0, 1, "accepted"], [1, 0, "pending"], [0, 0, "pending"], [1, 1, null]] as const)("fallback for pending=%s accepted=%s", (pending, accepted, expected) => {
		expect(selectMerchantFocus({ pending, accepted, newPending: [], deadlines: [], allowFallback: true })).toBe(expected);
		expect(selectMerchantFocus({ pending, accepted, newPending: [], deadlines: [], allowFallback: false })).toBeNull();
	});
});
