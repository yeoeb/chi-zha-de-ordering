import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/react-app/App";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });
function mockMenu() {
	vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input) === "/api/store"
		? {display_name: "吃炸的", is_accepting_orders: true}
		: {categories: [{id:1,name:"炸物",items:[]}]}), {status:200,headers:{"content-type":"application/json"}})));
}
describe("App route source follows the persistent URL", () => {
	it.each(["/onsite", "/ONSITE", "/Onsite", "/OnSite", "/onsite/"])("%s and refresh remain On-site", async (path) => {
		window.history.replaceState(null, "", path); mockMenu(); render(<App />);
		expect(await screen.findByText("現場點餐")).toBeTruthy();
		expect(window.location.pathname).toBe("/onsite");
		cleanup(); render(<App />);
		expect(await screen.findByText("現場點餐")).toBeTruthy();
		expect(window.location.pathname).toBe("/onsite");
	});
	it.each(["/onsite/cart", "/onsite/checkout"])("direct %s cannot turn into Online", async (path) => {
		window.history.replaceState(null, "", path); mockMenu(); render(<App />);
		expect(await screen.findByText("現場點餐")).toBeTruthy();
		await waitFor(() => expect(window.location.pathname).toBe("/onsite/cart"));
		cleanup(); render(<App />);
		expect(await screen.findByText("現場點餐")).toBeTruthy();
		await waitFor(() => expect(window.location.pathname).toBe("/onsite/cart"));
	});
	it("switches same-document Online → On-site → Online from history events", async () => {
		mockMenu(); render(<App />);
		expect(await screen.findByText("現點現炸")).toBeTruthy();
		expect(window.location.pathname).toBe("/");
		await act(async () => {window.history.pushState(window.history.state, "", "/onsite"); window.dispatchEvent(new PopStateEvent("popstate"));});
		expect(await screen.findByText("現場點餐")).toBeTruthy();
		expect(document.querySelector("main.onsite-ordering")).not.toBeNull();
		await act(async () => {window.history.pushState(window.history.state, "", "/"); window.dispatchEvent(new PopStateEvent("popstate"));});
		expect(await screen.findByText("現點現炸")).toBeTruthy();
		expect(document.querySelector("main.onsite-ordering")).toBeNull();
	});
});
