import { useLayoutEffect, useState } from "react";
import type { OrderSource } from "../shared/order-source";
import { getCustomerHomeRoute } from "./return-navigation";

export type CustomerSurface = "root" | "cart" | "checkout" | "orders" | `status:${string}`;
const ENTRY_KEY = "chiZhaDeCustomerNavigation";
type Entry = { rootId: string; source: OrderSource; rootPath: string; surface: CustomerSurface };
const isSurface = (value: unknown): value is CustomerSurface => typeof value === "string" &&
	(["root", "cart", "checkout", "orders"].includes(value) || value.startsWith("status:"));
const validRoot = (path: string, source: OrderSource) =>
	(source === "onsite" ? ["/onsite", "/store-order"] : ["/", "/order"]).includes(path);

function readEntry(state: unknown): Entry | null {
	const value = state && typeof state === "object" ? (state as Record<string, unknown>)[ENTRY_KEY] : null;
	if (!value || typeof value !== "object") return null;
	const entry = value as Entry;
	return typeof entry.rootId === "string" && (entry.source === "online" || entry.source === "onsite") &&
		typeof entry.rootPath === "string" && validRoot(entry.rootPath, entry.source) && isSurface(entry.surface) ? entry : null;
}

export function getCustomerParent(surface: CustomerSurface): CustomerSurface | null {
	if (surface.startsWith("status:")) return "orders";
	return surface === "checkout" ? "cart" : surface === "root" ? null : "root";
}

function chain(surface: CustomerSurface): CustomerSurface[] {
	const parent = getCustomerParent(surface);
	return parent === null ? [surface] : [...chain(parent), surface];
}

export function getCustomerRouteContext(source: OrderSource, target: Window = window) {
	const { search } = target.location;
	const pathname = target.location.pathname.replace(/\/$/, "");
	const home = new URLSearchParams(search).get("home");
	const stored = readEntry(target.history.state);
	// An explicit customer URL takes precedence over a stale history entry or home query.
	const rootPath = source === "onsite" && /^\/onsite(?:\/|$)/i.test(pathname) ? "/onsite"
		: source === "onsite" && /^\/store-order(?:\/|$)/.test(pathname) ? "/store-order"
		: source === "online" && /^\/order(?:\/|$)/.test(pathname) ? "/order"
		: source === "online" && ["", "/cart", "/checkout", "/orders"].includes(pathname) ? "/"
		: home && validRoot(home, source) ? home
		: stored?.source === source ? stored.rootPath : getCustomerHomeRoute(source);
	const detail = pathname.match(/^\/orders\/([^/]+)$/);
	const leaf = pathname.slice(pathname.lastIndexOf("/") + 1).toLowerCase();
	const requested = new URLSearchParams(search).get("view");
	const surface: CustomerSurface = detail ? `status:${detail[1]}`
		: ["cart", "checkout", "orders"].includes(leaf) ? leaf as CustomerSurface
		: requested && ["cart", "checkout", "orders"].includes(requested) ? requested as CustomerSurface : "root";
	return { rootPath, surface };
}

// Customer hierarchy is deliberately separate from Merchant's event-driven,
// one-secondary-entry navigation. Each entry has a real, source-specific URL.
export function createCustomerNavigation(target: Window, source: OrderSource, rootPath: string, onNavigate: (surface: CustomerSurface) => void) {
	let context = { source, rootPath };
	let rootId = readEntry(target.history.state)?.source === source ? readEntry(target.history.state)!.rootId : crypto.randomUUID();
	let traversing = false;
	let pendingOpen: CustomerSurface | null = null;
	const owns = (entry: Entry | null) => entry?.rootId === rootId;
	const url = (surface: CustomerSurface) => surface.startsWith("status:")
		? `/orders/${encodeURIComponent(surface.slice(7))}?source=${context.source}&home=${encodeURIComponent(context.rootPath)}`
		: surface === "root" ? context.rootPath : `${context.rootPath === "/" ? "" : context.rootPath}/${surface}`;
	const state = (surface: CustomerSurface) => ({ [ENTRY_KEY]: { ...context, rootId, surface } });
	const push = (surface: CustomerSurface) => target.history.pushState(state(surface), "", url(surface));
	const pop = () => {
		traversing = false;
		const current = readEntry(target.history.state);
		const path = target.location.pathname;
		const explicitSource = /^\/(?:onsite|store-order)(?:\/|$)/i.test(path) ? "onsite"
			: /^(?:\/|\/cart|\/checkout|\/order(?:\/(?:cart|checkout|orders))?)$/.test(path) ? "online" : null;
		// A stale owned entry must never rewrite a URL belonging to the other source.
		if (explicitSource !== null && explicitSource !== context.source && (!owns(current) || current?.source === context.source)) { pendingOpen = null; return; }
		if (!owns(current)) { pendingOpen = null; return; } // Root Back leaves natively.
		target.history.replaceState(state(current!.surface), "", url(current!.surface));
		if (pendingOpen !== null) {
			const desired = pendingOpen;
			pendingOpen = null;
			for (const child of chain(desired).slice(chain(current!.surface).length)) push(child);
			onNavigate(desired);
		} else onNavigate(current!.surface);
	};
	function open(surface: CustomerSurface) {
		if (traversing) return;
		const current = readEntry(target.history.state);
		const previous = owns(current) ? chain(current!.surface) : ["root"];
		const desired = chain(surface);
		let common = 0;
		while (common < previous.length && common < desired.length && previous[common] === desired[common]) common++;
		if (previous.length > common) {
			traversing = true;
			pendingOpen = desired.length > common ? surface : null;
			target.history.go(common - previous.length);
		} else {
			for (const child of desired.slice(common)) push(child);
			onNavigate(surface);
		}
	}
	return {
		updateCallback(callback: typeof onNavigate) { onNavigate = callback; },
		updateContext(nextSource: OrderSource, nextRoot: string) {
			context = { source: nextSource, rootPath: nextRoot };
			const current = readEntry(target.history.state);
			if (owns(current)) target.history.replaceState(state(current!.surface), "", url(current!.surface));
		},
		initialize(surface: CustomerSurface) {
			const current = readEntry(target.history.state);
			if (!owns(current) || current!.source !== context.source || current!.rootPath !== context.rootPath || current!.surface !== surface) {
				rootId = crypto.randomUUID();
				target.history.replaceState(state("root"), "", url("root"));
				for (const child of chain(surface).slice(1)) push(child);
			}
			target.addEventListener("popstate", pop);
			return () => target.removeEventListener("popstate", pop);
		},
		open,
		back() {
			const current = readEntry(target.history.state);
			if (owns(current)) {
				const parent = getCustomerParent(current!.surface);
				if (parent !== null) open(parent);
			}
		},
		returnToRoot() { open("root"); },
	};
}

export function useCustomerNavigation(source: OrderSource, rootPath: string, initialSurface: CustomerSurface, onNavigate: (surface: CustomerSurface) => void, enabled = true) {
	const [controller] = useState(() => createCustomerNavigation(window, source, rootPath, onNavigate));
	useLayoutEffect(() => { controller.updateCallback(onNavigate); });
	useLayoutEffect(() => { controller.updateContext(source, rootPath); }, [controller, source, rootPath]);
	useLayoutEffect(() => enabled ? controller.initialize(initialSurface) : undefined, [controller, enabled, initialSurface]);
	return controller;
}
