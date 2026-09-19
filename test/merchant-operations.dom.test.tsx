import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import MerchantView from "../src/react-app/MerchantView";

type MenuItem = { id: number; name: string; isAvailable: boolean; isQuickSoldOut?: boolean };

function json(value: unknown, status = 200) {
	return Promise.resolve(
		new Response(JSON.stringify(value), {
			status,
			headers: { "content-type": "application/json" },
		}),
	);
}

function order(overrides: Record<string, unknown> = {}) {
	return {
		id: "order-023",
		orderNumber: "023",
		status: "pending",
		total: 185,
		estimatedReadyAt: "2026-09-16T11:56:00.000Z",
		createdAt: "2026-09-16T11:40:00.000Z",
		customerName: "王小明",
		customerPhone: "0912345678",
		customerNote: "雞排不要切",
		packagingPreference: "separate_spicy",
		specialOrder: false,
		items: [
			{
				name: "香雞排",
				quantity: 1,
				lineTotal: 70,
				modifiers: [
					{ groupName: "辣度", name: "中辣" },
					{ groupName: "切法", name: "切" },
				],
			},
			{
				name: "香雞排",
				quantity: 1,
				lineTotal: 70,
				modifiers: [
					{ groupName: "辣度", name: "不辣" },
					{ groupName: "切法", name: "不切" },
				],
			},
			{
				name: "薯條",
				quantity: 1,
				lineTotal: 45,
				modifiers: [
					{ groupName: "調味", name: "胡椒" },
					{ groupName: "特殊選項：不加醬", name: "不加醬" },
				],
			},
		],
		...overrides,
	};
}

function createFetchMock({
	orders = [order()],
	failOrderAction = false,
	failAfterFirstPoll = false,
}: {
	orders?: Array<Record<string, unknown>>;
	failOrderAction?: boolean;
	failAfterFirstPoll?: boolean;
} = {}) {
	let orderPolls = 0;
	let items: MenuItem[] = [
		{ id: 1, name: "香雞排", isAvailable: true },
		{ id: 2, name: "青椒", isAvailable: false },
	];

	const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");

		if (url === "/api/merchant/orders" && method === "GET") {
			orderPolls += 1;
			if (failAfterFirstPoll && orderPolls > 1) return json({}, 503);
			return json({ orders });
		}
		if (url === "/api/merchant/notifications" && method === "GET") return json({ deliveries: [] });
		if (url === "/api/store" && method === "GET") {
			return json({ display_name: "吃炸的", is_accepting_orders: true, stateVersion: 1 });
		}
		if (url === "/api/menu" && method === "GET") {
			return json({ categories: [{ id: 1, name: "炸物", items }] });
		}
		if (url === "/api/merchant/orders/order-023/accept" && method === "POST") {
			return failOrderAction ? json({ error: { code: "FAILED" } }, 500) : json({ order: {} });
		}
		if (url === "/api/merchant/menu-items/1/sold-out" && method === "POST") {
			items = items.map((item) => item.id === 1 ? { ...item, isAvailable: false } : item);
			return json({ item: items[0] });
		}
		if (url === "/api/merchant/menu-items/1/restore" && method === "POST") {
			items = items.map((item) => item.id === 1 ? { ...item, isAvailable: true } : item);
			return json({ item: items[0] });
		}
		throw new Error(`Unexpected request: ${method} ${url}`);
	});

	return mock;
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Merchant operations UI", () => {
	it("has only 接單 and 售罄 as primary navigation and exposes no admin editing", async () => {
		vi.stubGlobal("fetch", createFetchMock());
		render(<MerchantView />);
		await screen.findByText("#023");

		const navigation = screen.getByRole("navigation", { name: "店家主要功能" });
		expect(within(navigation).getAllByRole("button").map((button) => button.textContent)).toEqual([
			"接單",
			"售罄",
		]);
		for (const label of ["價格", "商品編輯", "商品管理", "圖片", "分類", "Modifier 設定", "Menu CRUD", "Admin"]) {
			expect(screen.queryByText(label)).toBeNull();
		}
	});

	it("sorts cards by ready deadline and renders overdue urgency", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(new Date("2026-09-16T12:00:00.000Z"));
		vi.stubGlobal("fetch", createFetchMock({
			orders: [
				order({ id: "later", orderNumber: "024", estimatedReadyAt: "2026-09-16T12:15:00.000Z", customerNote: null }),
				order(),
			],
		}));
		render(<MerchantView />);
		await screen.findByText("#023");

		const cards = [...document.querySelectorAll<HTMLElement>(".merchant-order")];
		expect(cards.map((card) => within(card).getByText(/^#\d+/).textContent)).toEqual(["#023", "#024"]);
		expect(within(cards[0]).getByText("已逾時 4 分")).toBeTruthy();
		expect(within(cards[1]).getByText("剩 15 分")).toBeTruthy();
	});

	it("shows human-readable modifiers, distinct spice lines, and only non-null notes", async () => {
		vi.stubGlobal("fetch", createFetchMock({
			orders: [order(), order({ id: "no-note", orderNumber: "024", customerNote: null })],
		}));
		render(<MerchantView />);
		await screen.findByText("#023");

		expect(screen.getAllByText("辣度：中辣 · 切法：切").length).toBeGreaterThan(0);
		expect(screen.getAllByText("辣度：不辣 · 切法：不切").length).toBeGreaterThan(0);
		expect(screen.getAllByText("調味：胡椒 · 不加醬").length).toBeGreaterThan(0);
		expect(screen.getByText("雞排不要切")).toBeTruthy();
		expect(screen.getAllByText("辣／不辣分袋").length).toBeGreaterThan(0);
		const noNoteCard = screen.getByText("#024").closest("article");
		expect(noNoteCard && within(noNoteCard).queryByLabelText("訂單備註")).toBeNull();
	});

	it("exposes a disconnected state with the last sync after polling fails", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.stubGlobal("fetch", createFetchMock({ failAfterFirstPoll: true }));
		render(<MerchantView />);
		await screen.findByText("#023");

		await vi.advanceTimersByTimeAsync(5_000);
		await screen.findByText("連線中斷");
		expect(screen.getByLabelText("連線狀態").textContent).toContain("最後同步");
	});

	it("keeps the order pending when an order mutation fails", async () => {
		vi.stubGlobal("fetch", createFetchMock({ failOrderAction: true }));
		render(<MerchantView />);
		await screen.findByText("#023");

		const orderCard = screen.getByText("#023").closest("article");
		if (!orderCard) throw new Error("Missing order card");
		await userEvent.click(within(orderCard).getByRole("button", { name: "接單" }));

		await screen.findByRole("alert");
		expect(within(orderCard).getByRole("button", { name: "接單" })).toBeTruthy();
		expect(screen.getByText("#023")).toBeTruthy();
	});

	it("lists products and uses only the narrow sold-out and restore endpoints", async () => {
		const fetchMock = createFetchMock();
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		await screen.findByText("#023");
		const navigation = screen.getByRole("navigation", { name: "店家主要功能" });
		await userEvent.click(within(navigation).getByRole("button", { name: "售罄" }));

		expect(screen.getByText("香雞排")).toBeTruthy();
		expect(screen.getByText("青椒")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "售罄 香雞排" }));
		await screen.findByRole("button", { name: "恢復 香雞排" });
		await userEvent.click(screen.getByRole("button", { name: "恢復 香雞排" }));
		await screen.findByRole("button", { name: "售罄 香雞排" });

		const postedUrls = fetchMock.mock.calls
			.filter(([, init]) => init?.method === "POST")
			.map(([input]) => String(input));
		expect(postedUrls).toEqual([
			"/api/merchant/menu-items/1/sold-out",
			"/api/merchant/menu-items/1/restore",
		]);
		expect(document.querySelector("input[name='price']")).toBeNull();
	});

	it("automatically lists a newly created active product and uses its quick-sold-out metadata", async () => {
		const fetchMock = createFetchMock();
		const originalImplementation = fetchMock.getMockImplementation();
		fetchMock.mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? (input instanceof Request ? input.method : "GET");
			if (url === "/api/menu" && method === "GET") {
				return json({
					categories: [{
						id: 1,
						name: "炸物",
						items: [
							{ id: 1, name: "香雞排", isAvailable: true, isQuickSoldOut: true },
							{ id: 2, name: "青椒", isAvailable: false, isQuickSoldOut: false },
							{ id: 3, name: "新品雞塊", isAvailable: true, isQuickSoldOut: true },
						],
					}],
				});
			}
			if (!originalImplementation) throw new Error("Missing base fetch implementation");
			return originalImplementation(input, init);
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		await screen.findByText("#023");
		await userEvent.click(within(screen.getByRole("navigation", { name: "店家主要功能" })).getByRole("button", { name: "售罄" }));

		const quickSection = screen.getByRole("heading", { name: "快速售罄" }).closest("section");
		if (!quickSection) throw new Error("Missing quick-sold-out section");
		expect(within(quickSection).getByText("香雞排")).toBeTruthy();
		expect(within(quickSection).getByText("新品雞塊")).toBeTruthy();
		expect(within(quickSection).queryByText("青椒")).toBeNull();
		expect(screen.getAllByText("新品雞塊")).toHaveLength(2);
	});
});
