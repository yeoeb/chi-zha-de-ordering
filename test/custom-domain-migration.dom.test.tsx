// @vitest-environment-options {"url":"https://chizhade.com/"}
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/react-app/App";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-06T18:00:00+08:00")); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });

describe("Customer ordering on the new Origin", () => {
	it.each([["/", "online", "/api/orders"], ["/onsite", "onsite", "/api/onsite/orders"]] as const)("%s retains %s source and same-origin API calls", async (path, source, orderPath) => {
		expect(window.location.origin).toBe("https://chizhade.com");
		const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/store") return json({ display_name: "吃炸的", is_accepting_orders: true, customerPhoneMode: "optional" });
			if (url === "/api/menu") return json({ categories: [{ id: 1, name: "炸物", items: [{ id: 990, name: "測試餐點", description: "", price: 60, isAvailable: true, modifierGroups: [] }] }] });
			if (url === "/api/checkout/quote") return json({ items: [{ menuItemId: 990, name: "測試餐點", quantity: 1, unitPrice: 60, lineTotal: 60, modifiers: [] }], total: 60, leadMinutes: 20, estimatedReadyAt: "2026-10-06T10:20:00Z", quoteFingerprint: "a".repeat(64) });
			if (url === orderPath) return json({ order: { publicLookupToken: "b".repeat(64), orderNumber: "LOCAL-DOMAIN", status: "pending", orderSource: source, total: 60, createdAt: "2026-10-06T10:00:00Z", estimatedReadyAt: "2026-10-06T10:20:00Z", items: [], customerNote: null, packagingPreference: "together" } }, 201);
			if (url.startsWith("/api/orders/by-token/")) return json({ error: { code: "ORDER_NOT_FOUND" } }, 404);
			throw new Error("Unexpected API " + url);
		});
		window.history.replaceState(null, "", path);
		vi.stubGlobal("fetch", fetchMock);
		render(<App />);
		await userEvent.click(await screen.findByRole("button", { name: "加入 測試餐點" }));
		await userEvent.click(screen.getByRole("button", { name: /購物車共 1 件/ }));
		await userEvent.click(screen.getByRole("button", { name: "去結帳" }));
		await userEvent.click(await screen.findByRole("button", { name: "確認下單" }));
		await screen.findByText("等待店家接單");
		expect(fetchMock.mock.calls.filter(([url]) => String(url) === orderPath)).toHaveLength(1);
		for (const [url] of fetchMock.mock.calls) expect(new URL(String(url), window.location.href).origin).toBe("https://chizhade.com");
		expect(window.location.pathname).toBe(`/orders/${"b".repeat(64)}`);
		expect(new URLSearchParams(window.location.search).get("source")).toBe(source);
		expect(new URLSearchParams(window.location.search).get("home")).toBe(path);
	});
	it("resolves the unchanged Merchant manifest within the new Origin", () => {
		const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
		for (const path of [manifest.id, manifest.scope, manifest.start_url]) {
			expect(new URL(path, window.location.origin).origin).toBe("https://chizhade.com");
		}
		expect(new URL(manifest.start_url, window.location.origin).pathname).toBe("/merchant");
	});
	it("notificationclick opens same-origin Merchant even when payload contains an old/foreign URL", async () => {
		type Click = { notification: { close: () => void; data: { url: string } }; waitUntil: (work: Promise<unknown>) => void };
		const listeners = new Map<string, (event: Click) => void>();
		const opened: string[] = [];
		runInNewContext(readFileSync("public/service-worker.js", "utf8"), {
			URL,
			self: {
				location: { origin: window.location.origin },
				addEventListener: (type: string, handler: (event: Click) => void) => listeners.set(type, handler),
				clients: { matchAll: async () => [], openWindow: async (url: string) => { opened.push(url); return null; } },
			},
		});
		const work: Promise<unknown>[] = [];
		const close = vi.fn();
		listeners.get("notificationclick")!({ notification: { close, data: { url: "https://chi-zha-de-ordering.yeoeb55688.workers.dev/merchant" } }, waitUntil: pending => work.push(pending) });
		await Promise.all(work);
		expect(close).toHaveBeenCalledOnce();
		expect(opened).toEqual(["https://chizhade.com/merchant"]);
	});
});
