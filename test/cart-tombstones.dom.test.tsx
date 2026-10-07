import { afterEach, describe, expect, it, vi } from "vitest";
import { CartTombstoneTimers } from "../src/react-app/cart-tombstones";
import { cartReducer, createCartLine, getCartItemCount, getCartTotal, toCheckoutItems, type CartAction, type CartLine } from "../src/react-app/cart";

const item = { id: 9, name: "薯條", price: 40 };
const pepper = createCartLine(item, [{ groupId: 5, groupName: "調味", optionId: 16, optionName: "胡椒", priceDelta: 0 }]);
const plum = createCartLine(item, [{ groupId: 5, groupName: "調味", optionId: 15, optionName: "梅粉", priceDelta: 0 }]);

function harness() {
	vi.useFakeTimers();
	let cart: CartLine[] = [];
	const expired = vi.fn((line: CartLine) => {
		if (cart.find((current) => current.id === line.id) !== line || line.quantity !== 0) return;
		cart = cartReducer(cart, { type: "remove", lineId: line.id });
	});
	const timers = new CartTombstoneTimers(expired);
	return {
		get cart() { return cart; }, expired, timers,
		mutate(action: CartAction) { cart = cartReducer(cart, action); timers.sync(cart); },
	};
}
afterEach(() => { vi.useRealTimers(); });

describe("one-second zero-quantity tombstones", () => {
	it("preserves identity/modifiers for 999ms, excludes zero from checkout/count/total, then hard removes at 1000ms", () => {
		const h = harness();
		h.mutate({ type: "add", line: pepper });
		h.mutate({ type: "decrease", lineId: pepper.id });
		expect(h.cart).toEqual([{ ...pepper, quantity: 0 }]);
		expect(getCartItemCount(h.cart)).toBe(0);
		expect(getCartTotal(h.cart)).toBe(0);
		expect(toCheckoutItems(h.cart)).toEqual([]);
		vi.advanceTimersByTime(999);
		expect(h.cart).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(h.cart).toEqual([]);
		expect(h.expired).toHaveBeenCalledTimes(1);
	});
	it("restores the same line at 999ms and cancels its old removal timer", () => {
		const h = harness();
		h.mutate({ type: "add", line: pepper });
		h.mutate({ type: "decrease", lineId: pepper.id });
		vi.advanceTimersByTime(999);
		h.mutate({ type: "increase", lineId: pepper.id });
		vi.advanceTimersByTime(2000);
		expect(h.cart).toEqual([{ ...pepper, quantity: 1 }]);
		expect(h.expired).not.toHaveBeenCalled();
	});
	it("starts a fresh full second for 0 -> 1 -> 0, even without an intermediate render", () => {
		const h = harness();
		h.mutate({ type: "add", line: pepper });
		h.mutate({ type: "decrease", lineId: pepper.id });
		vi.advanceTimersByTime(500);
		h.mutate({ type: "increase", lineId: pepper.id });
		h.mutate({ type: "decrease", lineId: pepper.id });
		vi.advanceTimersByTime(999);
		expect(h.cart).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(h.cart).toEqual([]);
		expect(h.expired).toHaveBeenCalledTimes(1);
	});
	it("reuses the exact identity on menu re-add within TTL and creates one clean line after expiry", () => {
		const h = harness();
		h.mutate({ type: "add", line: pepper });
		h.mutate({ type: "decrease", lineId: pepper.id });
		h.mutate({ type: "add", line: pepper });
		vi.advanceTimersByTime(1000);
		expect(h.cart).toEqual([{ ...pepper, quantity: 1 }]);
		h.mutate({ type: "decrease", lineId: pepper.id });
		vi.advanceTimersByTime(1000);
		h.mutate({ type: "add", line: pepper });
		vi.advanceTimersByTime(1000);
		expect(h.cart).toEqual([{ ...pepper, quantity: 1 }]);
	});
	it("uses independent identity timers, never deletes another configuration, and does not extend expiry on unrelated updates", () => {
		const h = harness();
		h.mutate({ type: "add", line: pepper }); h.mutate({ type: "add", line: plum });
		h.mutate({ type: "decrease", lineId: pepper.id });
		vi.advanceTimersByTime(500);
		h.mutate({ type: "increase", lineId: plum.id });
		h.mutate({ type: "decrease", lineId: pepper.id }); // Already zero: no new generation.
		vi.advanceTimersByTime(500);
		expect(h.cart).toEqual([{ ...plum, quantity: 2 }]);
		expect(h.expired).toHaveBeenCalledTimes(1);
	});
	it("cancels every timer on teardown and tolerates StrictMode cleanup/re-setup", () => {
		const h = harness();
		h.mutate({ type: "add", line: pepper }); h.mutate({ type: "decrease", lineId: pepper.id });
		h.timers.clear();
		vi.advanceTimersByTime(2000);
		expect(h.expired).not.toHaveBeenCalled();
		h.timers.sync(h.cart);
		vi.advanceTimersByTime(1000);
		expect(h.cart).toEqual([]);
	});
});
