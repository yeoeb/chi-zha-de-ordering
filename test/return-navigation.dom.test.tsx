import { describe, expect, it, vi } from "vitest";
import { createReturnNavigation, getCustomerHomeRoute } from "../src/react-app/return-navigation";
import { createCustomerNavigation, getCustomerParent, getCustomerRouteContext, type CustomerSurface } from "../src/react-app/customer-navigation";

// Real history operations modeled without cross-test JSDOM stack leakage.
function historyWindow(path: string) {
	const entries: Array<{ state: unknown; url: string }> = [
		{ state: null, url: "https://external.invalid/page" }, { state: null, url: `https://shop.test${path}` },
	];
	let index = 1;
	const pop = new Set<() => void>();
	const target = {
		get location() { return new URL(entries[index]!.url); },
		history: {
			get state() { return entries[index]!.state; },
			get length() { return entries.length; },
			replaceState(state: unknown, _title: string, url?: string) { entries[index] = { state, url: url ? new URL(url, entries[index]!.url).href : entries[index]!.url }; },
			pushState(state: unknown, _title: string, url: string) { entries.splice(index + 1); entries.push({ state, url: new URL(url, entries[index]!.url).href }); index++; },
			go(delta: number) { if (entries[index + delta]) { index += delta; pop.forEach((handler) => handler()); } },
		},
		addEventListener(_type: string, handler: () => void) { pop.add(handler); },
		removeEventListener(_type: string, handler: () => void) { pop.delete(handler); },
	};
	return target as unknown as Window;
}

describe("canonical return history, shared by visible and system Back", () => {
	it("ignores a second visible return while the owned history traversal is still pending", () => {
		const target = historyWindow("/order");
		const nav = createCustomerNavigation(target, "online", "/order", vi.fn());
		nav.initialize("root");
		nav.open("checkout");
		const traverse = target.history.go.bind(target.history);
		const go = vi.spyOn(target.history, "go").mockImplementation(() => undefined);
		nav.back();
		nav.back();
		expect(go).toHaveBeenCalledOnce();
		traverse(-1);
		expect(target.location.pathname).toBe("/order/cart");
		go.mockRestore();
		nav.back();
		target.history.go(-1);
		expect(target.location.origin).toBe("https://external.invalid");
	});
	it.each(["checkout", "orders", "status:opaque", "cart"] as CustomerSurface[])("Customer %s → system Back → parent → root → next Back leaves", (surface) => {
		const target = historyWindow("/order");
		const changed = vi.fn();
		const nav = createCustomerNavigation(target, "online", "/order", changed);
		nav.initialize("root");
		nav.open(surface);
		target.history.go(-1);
		expect(changed).toHaveBeenLastCalledWith(getCustomerParent(surface));
		if (getCustomerParent(surface) !== "root") target.history.go(-1);
		expect(target.location.pathname).toBe("/order");
		expect(changed).toHaveBeenLastCalledWith("root");
		const calls = changed.mock.calls.length;
		target.history.go(-1);
		expect(target.location.origin).toBe("https://external.invalid");
		expect(changed).toHaveBeenCalledTimes(calls);
	});
	it.each(["online", "onsite"] as const)("visible return preserves %s source and consumes the same sentinel", (source) => {
		const root = getCustomerHomeRoute(source);
		const target = historyWindow(root);
		const nav = createCustomerNavigation(target, source, root, vi.fn());
		nav.initialize("root");
		for (let repeat = 0; repeat < 4; repeat++) {
			nav.open("orders");
			nav.open("status:opaque");
			expect(target.history.length).toBe(4);
			nav.back();
			expect(target.location.pathname).toBe(`${root}/orders`);
			nav.returnToRoot();
			expect(target.location.pathname).toBe(root);
		}
		target.history.go(-1);
		expect(target.location.origin).toBe("https://external.invalid");
	});
	it.each(["history", "revenue", "accepted", "availability"])("Merchant %s returns to pending without stale tab traversal", (surface) => {
		const target = historyWindow("/merchant");
		const pending = vi.fn();
		const nav = createReturnNavigation(target, "merchant", "/merchant", pending);
		nav.initialize("root");
		nav.open("accepted", "/merchant");
		nav.open("availability", "/merchant");
		nav.open(surface, surface === "history" || surface === "revenue" ? `/merchant/${surface}` : "/merchant");
		expect(target.history.length).toBe(3);
		nav.returnToRoot();
		expect(target.location.pathname).toBe("/merchant");
		expect(pending).toHaveBeenLastCalledWith("root");
		target.history.go(-1);
		expect(target.location.origin).toBe("https://external.invalid");
	});
	it("direct deep link and refresh keep one root sentinel, never a Back trap", () => {
		const target = historyWindow("/orders/opaque?source=onsite");
		const nav = createCustomerNavigation(target, "onsite", "/store-order", vi.fn());
		const dispose = nav.initialize("status:opaque");
		expect(target.history.length).toBe(4);
		dispose();
		const refreshed = createCustomerNavigation(target, "onsite", "/store-order", vi.fn());
		refreshed.initialize("status:opaque");
		expect(target.history.length).toBe(4);
		refreshed.back();
		expect(target.location.pathname).toBe("/store-order/orders");
		refreshed.back();
		expect(target.location.pathname).toBe("/store-order");
		target.history.go(-1);
		expect(target.location.origin).toBe("https://external.invalid");
	});
	it("a deep-linked Order can resolve its onsite source from the authoritative lookup", () => {
		const target = historyWindow("/orders/opaque");
		const nav = createCustomerNavigation(target, "online", "/order", vi.fn());
		nav.initialize("status:opaque");
		nav.updateContext("onsite", "/store-order");
		target.history.go(-1);
		expect(target.location.pathname).toBe("/store-order/orders");
		target.history.go(-1);
		expect(target.location.pathname).toBe("/store-order");
	});
	it.each([
		["online", "/", "/checkout", "/cart"],
		["onsite", "/onsite", "/onsite/checkout", "/onsite/cart"],
		["online", "/order", "/order/checkout", "/order/cart"],
		["onsite", "/store-order", "/store-order/checkout", "/store-order/cart"],
	] as const)("direct %s checkout refresh keeps %s parent chain and Forward", (source, root, child, parent) => {
		const target = historyWindow(child);
		expect(getCustomerRouteContext(source, target)).toEqual({ rootPath: root, surface: "checkout" });
		const nav = createCustomerNavigation(target, source, root, vi.fn());
		const dispose = nav.initialize("checkout");
		dispose();
		const refreshed = createCustomerNavigation(target, source, root, vi.fn());
		refreshed.initialize("checkout");
		expect(target.history.length).toBe(4);
		refreshed.back();
		expect(target.location.pathname).toBe(parent);
		target.history.go(1);
		expect(target.location.pathname).toBe(child);
		target.history.go(-1);
		target.history.go(-1);
		expect(target.location.pathname).toBe(root);
		target.history.go(-1);
		expect(target.location.origin).toBe("https://external.invalid");
	});
	it("switches checkout to order detail with the Orders parent, without stale checkout entries", () => {
		const target = historyWindow("/store-order");
		const nav = createCustomerNavigation(target, "onsite", "/store-order", vi.fn());
		nav.initialize("root");
		nav.open("cart");
		nav.open("checkout");
		nav.open("status:opaque");
		expect(target.history.length).toBe(4);
		nav.back();
		expect(target.location.pathname).toBe("/store-order/orders");
		nav.back();
		expect(target.location.pathname).toBe("/store-order");
	});
	it("repairs stale surface metadata from the persistent URL without changing source", () => {
		const target = historyWindow("/onsite");
		const nav = createCustomerNavigation(target, "onsite", "/onsite", vi.fn());
		const dispose = nav.initialize("root");
		target.history.replaceState(target.history.state, "", "/onsite/checkout");
		dispose();
		const context = getCustomerRouteContext("onsite", target);
		const reopened = createCustomerNavigation(target, "onsite", context.rootPath, vi.fn());
		reopened.initialize(context.surface);
		expect(target.history.length).toBe(4);
		reopened.back();
		expect(target.location.pathname).toBe("/onsite/cart");
		reopened.back();
		expect(target.location.pathname).toBe("/onsite");
	});
});
