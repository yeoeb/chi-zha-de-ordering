import { useLayoutEffect, useState } from "react";
import type { OrderSource } from "../shared/order-source";

export function getCustomerHomeRoute(source: OrderSource) {
	return source === "onsite" ? "/onsite" : "/";
}

type Entry = { scope: string; rootId: string; surface: string; rootPath: string };
const ENTRY_KEY = "chiZhaDeNavigation";
const createRootId = () => Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16).padStart(8, "0")).join("");

function readEntry(state: unknown): Entry | null {
	const value = state && typeof state === "object"
		? (state as Record<string, unknown>)[ENTRY_KEY] : null;
	if (!value || typeof value !== "object") return null;
	const entry = value as Entry;
	return typeof entry.scope === "string" && typeof entry.rootId === "string" &&
		typeof entry.surface === "string" && typeof entry.rootPath === "string" ? entry : null;
}

export function getNavigationSurface(scope: string) {
	const entry = readEntry(window.history.state);
	return entry?.scope === scope ? entry.surface : null;
}

// One canonical entry + at most one secondary entry. Switching secondary surfaces
// replaces that entry, so Back always reaches root, never a stale intermediate view.
export function createReturnNavigation(
	window: Window,
	scope: string,
	rootPath: string,
	onNavigate: (surface: string) => void,
) {
	let canonicalPath = rootPath;
	let returning = false;
	let rootId = readEntry(window.history.state)?.scope === scope
		? readEntry(window.history.state)!.rootId : createRootId();
	const entry = (surface: string) => ({ [ENTRY_KEY]: { scope, rootId, surface, rootPath: canonicalPath } });
	const owns = (value: Entry | null) => value?.scope === scope && value.rootId === rootId;
	const pop = () => {
		returning = false;
		const value = readEntry(window.history.state);
		if (!owns(value)) return; // At root, the next Back belongs to the browser.
		if (value!.surface === "root") window.history.replaceState(entry("root"), "", canonicalPath);
		onNavigate(value!.surface);
	};
	return {
		updateCallback(callback: (surface: string) => void) { onNavigate = callback; },
		initialize(surface: string) {
			const current = readEntry(window.history.state);
			if (!owns(current)) {
				const secondaryUrl = window.location.pathname + window.location.search;
				rootId = createRootId();
				window.history.replaceState(entry("root"), "", canonicalPath);
				if (surface !== "root") window.history.pushState(entry(surface), "", secondaryUrl);
			} else if (surface !== current!.surface) {
				window.history.replaceState(entry(surface), "");
			}
			window.addEventListener("popstate", pop);
			return () => window.removeEventListener("popstate", pop);
		},
		updateRoot(path: string) { canonicalPath = path; },
		open(surface: string, url: string) {
			const current = readEntry(window.history.state);
			if (!owns(current)) {
				window.history.replaceState(entry("root"), "", canonicalPath);
				window.history.pushState(entry(surface), "", url);
			} else if (current!.surface === "root") {
				window.history.pushState(entry(surface), "", url);
			} else {
				window.history.replaceState(entry(surface), "", url);
			}
			onNavigate(surface);
		},
		returnToRoot() {
			if (returning) return;
			const current = readEntry(window.history.state);
			if (owns(current) && current!.surface !== "root") {
				// Only traverse a pair that THIS controller established. Not generic Back.
				// System Back reaches the same pop handler and canonical destination.
				returning = true;
				window.history.go(-1);
			} else {
				window.history.replaceState(entry("root"), "", canonicalPath);
				onNavigate("root");
			}
		},
	};
}

export function useReturnNavigation(scope: string, rootPath: string, initialSurface: string, onNavigate: (surface: string) => void, enabled = true) {
	const [controller] = useState(() => createReturnNavigation(window, scope, rootPath, onNavigate));
	useLayoutEffect(() => { controller.updateCallback(onNavigate); });
	useLayoutEffect(() => enabled ? controller.initialize(initialSurface) : undefined, [controller, enabled, initialSurface]);
	useLayoutEffect(() => { controller.updateRoot(rootPath); }, [controller, rootPath]);
	return controller;
}
