import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/react-app/App";
import CustomerOrderStatus from "../src/react-app/CustomerOrderStatus";

function json(value: unknown, status = 200) {
	return Promise.resolve(new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	}));
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
	sessionStorage.clear();
	window.history.replaceState(null, "", "/");
});

describe("onsite customer ordering", () => {
	it.each(["/onsite", "/store-order"])("uses %s shared menu and quote flow without requesting contact fields", async (root) => {
		window.history.replaceState(null, "", root);
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/api/store") {
				return json({ display_name: "吃炸的", is_accepting_orders: true });
			}
			if (url === "/api/menu") {
				return json({ categories: [{
					id: 1,
					name: "炸物",
					items: [{
						id: 771,
						name: "現場雞排",
						description: "現點現炸",
						price: 85,
						isAvailable: true,
						imageUrl: null,
						isPopular: false,
						modifierGroups: [],
					}],
				}] });
			}
			if (url === "/api/checkout/quote") {
				return json({
					items: [{
						menuItemId: 771,
						name: "現場雞排",
						quantity: 1,
						unitPrice: 85,
						lineTotal: 85,
						modifiers: [],
					}],
					total: 85,
					estimatedReadyAt: "2026-09-25T05:30:00.000Z",
					leadMinutes: 20,
					quoteFingerprint: "c".repeat(64),
				});
			}
			if (url === "/api/onsite/orders") {
				return json({ order: {
					publicLookupToken: "d".repeat(64),
					orderNumber: "CZ-ONSITE",
					status: "pending",
					orderSource: "onsite",
					customerName: "現場顧客",
					customerNote: null,
					packagingPreference: "together",
					createdAt: "2026-09-25T05:00:00.000Z",
					estimatedReadyAt: "2026-09-25T05:30:00.000Z",
					total: 85,
					items: [],
				} }, 201);
			}
			throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<App />);

		expect(await screen.findByText("現場點餐")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "加入 現場雞排" }));
		await userEvent.click(screen.getByRole("button", { name: /購物車共 1 件/ }));
		await userEvent.click(screen.getByRole("button", { name: "去結帳" }));
		expect(await screen.findByText("送出後請留意訂單畫面；餐點完成後即可取餐。")).toBeTruthy();
		expect(screen.queryByText("姓名")).toBeNull();
		expect(screen.queryByText("電話")).toBeNull();
		expect(screen.queryByText("預計完成時間")).toBeNull();
		expect(screen.queryByRole("group", { name: "如果餐點售完" })).toBeNull();
		expect(screen.queryByRole("radio")).toBeNull();
		expect(screen.queryByText("其他餐點繼續製作")).toBeNull();
		expect(screen.queryByText("取消整筆訂單")).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: "← 返回購物車" }));
		await screen.findByRole("heading", { name: "購物車" });
		expect(window.location.pathname).toBe(`${root}/cart`);
		expect(screen.getByText("現場雞排 × 1")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "← 繼續點餐" }));
		await screen.findByRole("heading", { name: "炸物" });
		expect(window.location.pathname).toBe(root);
		await userEvent.click(screen.getByRole("button", { name: /購物車共 1 件/ }));
		await userEvent.click(screen.getByRole("button", { name: "去結帳" }));
		await screen.findByText("應付金額");
		cleanup();
		render(<App />);
		await screen.findByText("應付金額");
		expect(window.location.pathname).toBe(`${root}/checkout`);
		expect(screen.queryByRole("textbox", { name: /電話/ })).toBeNull();

		expect(screen.queryByRole("group", { name: "如果餐點售完" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));
		expect(await screen.findByRole("heading", { name: "現場點餐" })).toBeTruthy();
		expect(screen.getByText("餐點完成後即可取餐")).toBeTruthy();
		expect(screen.queryByText("預計取餐時間")).toBeNull();

		await waitFor(() => {
			const orderCall = fetchMock.mock.calls.find(([input]) => input === "/api/onsite/orders");
			expect(orderCall).toBeTruthy();
			const body = JSON.parse(String(orderCall?.[1]?.body)) as Record<string, unknown>;
			expect(body.customerName).toBeUndefined();
			expect(body.customerPhone).toBeUndefined();
			expect(body.orderSource).toBeUndefined();
			expect(body).not.toHaveProperty("shortagePolicy");
			expect(body.items).toEqual([{ menuItemId: 771, quantity: 1, modifierOptionIds: [] }]);
		});
	});

	it("keeps a completed onsite order visible with the pickup-screen instruction", () => {
		render(<CustomerOrderStatus
			publicLookupToken={"e".repeat(64)}
			initialOrder={{
				publicLookupToken: "e".repeat(64),
				orderNumber: "CZ-ONSITE-DONE",
				status: "completed",
				orderSource: "onsite",
				customerName: "現場顧客",
				customerNote: null,
				packagingPreference: "together",
				createdAt: "2026-09-25T05:00:00.000Z",
				estimatedReadyAt: "2026-09-25T05:30:00.000Z",
				total: 85,
				items: [],
			}}
		/>);
		expect(screen.getByRole("heading", { name: "餐點已完成" })).toBeTruthy();
		expect(screen.getByText("可以取餐了")).toBeTruthy();
		expect(screen.getByText("請向店家出示此訂單畫面")).toBeTruthy();
		expect(screen.queryByText("預計取餐時間")).toBeNull();
	});
});
