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
				id: "line-chicken-medium",
				menuItemId: 1,
				name: "香雞排",
				quantity: 1,
				lineTotal: 70,
				modifiers: [
					{ groupName: "辣度", name: "中辣" },
					{ groupName: "切法", name: "切" },
				],
			},
			{
				id: "line-chicken-none",
				menuItemId: 1,
				name: "香雞排",
				quantity: 1,
				lineTotal: 70,
				modifiers: [
					{ groupName: "辣度", name: "不辣" },
					{ groupName: "切法", name: "不切" },
				],
			},
			{
				id: "line-fries",
				menuItemId: 9,
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
	historyOrders = [],
	orderActionStatus,
	failAfterFirstPoll = false,
	orderPollSequence,
}: {
	orders?: Array<Record<string, unknown>>;
	historyOrders?: Array<Record<string, unknown>>;
	orderActionStatus?: number;
	failAfterFirstPoll?: boolean;
	orderPollSequence?: Array<Array<Record<string, unknown>>>;
} = {}) {
	let orderPolls = 0;
	let activeOrders = [...orders];
	let history: Array<Record<string, unknown>> = [...historyOrders];
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
			if (orderPollSequence) {
				activeOrders = orderPollSequence[Math.min(orderPolls - 1, orderPollSequence.length - 1)];
			}
			return json({ orders: activeOrders, history });
		}
		if (url === "/api/merchant/notifications" && method === "GET") return json({ deliveries: [] });
		if (url === "/api/store" && method === "GET") {
			return json({ display_name: "吃炸的", is_accepting_orders: true, stateVersion: 1 });
		}
		if (url === "/api/menu" && method === "GET") {
			return json({ categories: [{ id: 1, name: "炸物", items }] });
		}
		const actionMatch = url.match(/^\/api\/merchant\/orders\/([^/]+)\/(accept|reject|complete)$/);
		if (actionMatch && method === "POST") {
			if (orderActionStatus) {
				const code = orderActionStatus === 403
					? "ORIGIN_DENIED"
					: orderActionStatus === 409
						? "ILLEGAL_ORDER_TRANSITION"
						: "FAILED";
				return json({ error: { code } }, orderActionStatus);
			}
			const [, orderId, action] = actionMatch;
			const current = activeOrders.find((candidate) => candidate.id === orderId);
			if (!current) return json({ error: { code: "ORDER_NOT_FOUND" } }, 404);
			const status = action === "accept" ? "accepted" : action === "reject" ? "rejected" : "completed";
			const updated = { ...current, status };
			activeOrders = action === "accept"
				? activeOrders.map((candidate) => candidate.id === orderId ? updated : candidate)
				: activeOrders.filter((candidate) => candidate.id !== orderId);
			if (action !== "accept") history = [updated, ...history];
			return json({ order: updated });
		}
		const shortageMatch = url.match(/^\/api\/merchant\/orders\/([^/]+)\/shortages$/);
		if (shortageMatch && method === "POST") {
			const body = JSON.parse(String(init?.body)) as { items: Array<{ orderItemId: string; quantity: number }> };
			const current = activeOrders.find((candidate) => candidate.id === shortageMatch[1]);
			if (!current) return json({ error: { code: "ORDER_NOT_FOUND" } }, 404);
			const currentItems = current.items as Array<Record<string, unknown>>;
			const shortage = body.items[0]!;
			const targeted = currentItems.find((candidate) => candidate.id === shortage.orderItemId);
			if (!targeted) return json({ error: { code: "ORDER_ITEM_NOT_FOUND" } }, 422);
			const menuItemId = Number(targeted.menuItemId);
			items = items.map((item) => item.id === menuItemId ? { ...item, isAvailable: false } : item);
			const updated = {
				...current,
				total: Number(current.total) - (Number(targeted.lineTotal) / Number(targeted.quantity)) * shortage.quantity,
				items: currentItems.map((candidate) => candidate.id === shortage.orderItemId
					? { ...candidate, quantity: Number(candidate.quantity) - shortage.quantity }
					: candidate),
			};
			activeOrders = activeOrders.map((candidate) => candidate.id === current.id ? updated : candidate);
			return json({ order: updated });
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
	localStorage.clear();
});

describe("Merchant operations UI", () => {
	it("has only 待接單, 製作中, and 售罄 as primary navigation and exposes no admin editing", async () => {
		vi.stubGlobal("fetch", createFetchMock());
		render(<MerchantView />);
		await screen.findByLabelText("訂單 #023");

		const navigation = screen.getByRole("navigation", { name: "店家主要功能" });
		expect(within(navigation).getAllByRole("button").map((button) => button.textContent)).toEqual([
			"待接單 1",
			"製作中 0",
			"售罄",
		]);
		for (const label of ["價格", "商品編輯", "商品管理", "圖片", "分類", "Modifier 設定", "Menu CRUD", "Admin"]) {
			expect(screen.queryByText(label)).toBeNull();
		}
		const activeCard = screen.getByLabelText("訂單 #023");
		expect(within(activeCard).getByText("網路")).toBeTruthy();
		expect(within(activeCard).queryByText("王小明")).toBeNull();
		expect(within(activeCard).queryByText("0912345678")).toBeNull();
		expect(within(activeCard).queryByText("NT$ 185")).toBeNull();
		expect(within(activeCard).queryByText("訂單 #023")).toBeNull();
		expect(screen.queryByText("通知狀態")).toBeNull();
	});

	it("labels onsite work and shows the backend snapshot total only after acceptance", async () => {
		vi.stubGlobal("fetch", createFetchMock({
			orders: [order({ status: "accepted", orderSource: "onsite", customerName: "現場顧客", customerPhone: "現場免填" })],
		}));
		render(<MerchantView />);
		await screen.findByRole("button", { name: /製作中 1/ });
		await userEvent.click(screen.getByRole("button", { name: /製作中 1/ }));
		const card = await screen.findByLabelText("訂單 #023");
		expect(within(card).getByText("現場")).toBeTruthy();
		expect(within(card).getByText("NT$ 185")).toBeTruthy();
		expect(within(card).queryByText("現場顧客")).toBeNull();
	});

	it("sorts current cards by ready deadline without showing countdown or overdue copy", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(new Date("2026-09-16T12:00:00.000Z"));
		vi.stubGlobal("fetch", createFetchMock({
			orders: [
				order({ id: "later", orderNumber: "024", estimatedReadyAt: "2026-09-16T12:15:00.000Z", customerNote: null }),
				order(),
			],
		}));
		render(<MerchantView />);
		await screen.findByLabelText("訂單 #023");

		const cards = screen.getAllByLabelText(/訂單 #/);
		expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(["訂單 #023", "訂單 #024"]);
		expect(within(cards[0]!).getByText("19:56")).toBeTruthy();
		expect(screen.queryByText("已逾時 4 分")).toBeNull();
		expect(within(cards[1]!).getByText("20:15")).toBeTruthy();
		expect(screen.queryByText("剩 15 分")).toBeNull();
		expect(screen.queryByRole("button", { name: "下一筆" })).toBeNull();
	});

	it("uses the actual deadline date in history and distinguishes equal times on different days", async () => {
		vi.stubGlobal("fetch", createFetchMock({
			orders: [],
			historyOrders: [
				order({ id: "day-one", orderNumber: "031", status: "completed", estimatedReadyAt: "2026-09-16T11:20:00.000Z" }),
				order({ id: "day-two", orderNumber: "032", status: "rejected", estimatedReadyAt: "2026-09-17T11:20:00.000Z" }),
			],
		}));
		render(<MerchantView />);
		await screen.findByText("目前沒有待接單");
		await userEvent.click(screen.getByRole("button", { name: "歷史訂單" }));
		expect(screen.getAllByText("2026/09/16 19:20").length).toBeGreaterThan(0);
		expect(screen.getAllByText("2026/09/17 19:20").length).toBeGreaterThan(0);
	});

	it("shows human-readable modifiers, distinct spice lines, and only non-null notes", async () => {
		vi.stubGlobal("fetch", createFetchMock({
			orders: [
				order(),
				order({ id: "no-note", orderNumber: "024", customerNote: null, estimatedReadyAt: "2026-09-16T12:20:00.000Z" }),
			],
		}));
		render(<MerchantView />);
		await screen.findByLabelText("訂單 #023");

		const noSpiceHeading = screen.getAllByRole("heading", { name: "不辣" })[0]!;
		const mediumSpiceHeading = screen.getAllByRole("heading", { name: "中辣" })[0]!;
		expect(noSpiceHeading.closest("section")?.classList.contains("spice-none")).toBe(true);
		expect(mediumSpiceHeading.closest("section")?.classList.contains("spice-medium")).toBe(true);
		expect(screen.getAllByText("切法：切").length).toBeGreaterThan(0);
		expect(screen.getAllByText("切法：不切").length).toBeGreaterThan(0);
		expect(screen.getAllByText("調味：胡椒 · 不加醬").length).toBeGreaterThan(0);
		expect(screen.getByText("雞排不要切")).toBeTruthy();
		expect(screen.getAllByText("辣／不辣分袋").length).toBeGreaterThan(0);
		const noNoteCard = screen.getByLabelText("訂單 #024");
		expect(noNoteCard && within(noNoteCard).queryByLabelText("訂單備註")).toBeNull();
	});

	it("exposes a disconnected state with the last sync after polling fails", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.stubGlobal("fetch", createFetchMock({ failAfterFirstPoll: true }));
		render(<MerchantView />);
		await screen.findByLabelText("訂單 #023");

		await vi.advanceTimersByTimeAsync(5_000);
		await screen.findByText("連線中斷");
		expect(screen.getByLabelText("連線狀態").textContent).toContain("連線中斷");
	});

	it("keeps the order pending when an order mutation fails", async () => {
		vi.stubGlobal("fetch", createFetchMock({ orderActionStatus: 403 }));
		render(<MerchantView />);
		await screen.findByLabelText("訂單 #023");

		const orderCard = screen.getByLabelText("訂單 #023");
		if (!orderCard) throw new Error("Missing order card");
		await userEvent.click(within(orderCard).getByRole("button", { name: "接單" }));

		await screen.findByText(/ORIGIN_DENIED/);
		expect(within(orderCard).getByRole("button", { name: "接單" })).toBeTruthy();
		expect(screen.getByLabelText("訂單 #023")).toBeTruthy();
	});

	it("shows all five pending Orders as directly actionable vertical cards", async () => {
		vi.stubGlobal("fetch", createFetchMock({
			orders: Array.from({ length: 5 }, (_, index) => order({
				id: `order-${index + 1}`,
				orderNumber: `02${index + 1}`,
				estimatedReadyAt: `2026-09-16T12:${String(10 + index).padStart(2, "0")}:00.000Z`,
			})),
		}));
		render(<MerchantView />);
		await screen.findByLabelText("訂單 #021");

		expect(screen.getByText("依預計完成時間排序，共 5 筆")).toBeTruthy();
		for (let index = 1; index <= 5; index += 1) {
			const card = screen.getByLabelText(`訂單 #02${index}`);
			expect(within(card).getByRole("button", { name: "接單" })).toBeTruthy();
		}
		expect(screen.queryByRole("button", { name: "下一筆" })).toBeNull();
		expect(screen.queryByRole("button", { name: "返回待接單清單" })).toBeNull();
	});

	it("moves an accepted Order to production without leaving the pending list and reopens it by shortcut", async () => {
		const fetchMock = createFetchMock({
			orders: [
				order(),
				order({ id: "order-024", orderNumber: "024", estimatedReadyAt: "2026-09-16T12:20:00.000Z" }),
			],
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		const firstCard = await screen.findByLabelText("訂單 #023");

		await userEvent.click(within(firstCard).getByRole("button", { name: "接單" }));
		await screen.findByText("已接單 #023");
		expect(screen.getByRole("button", { name: /待接單 1/ }).getAttribute("aria-current")).toBe("page");
		expect(screen.getByLabelText("訂單 #024")).toBeTruthy();
		expect(screen.getByRole("button", { name: /製作中 1/ })).toBeTruthy();

		await userEvent.click(screen.getByRole("button", { name: "查看剛接的訂單" }));
		expect(screen.getByRole("button", { name: /製作中 1/ }).getAttribute("aria-current")).toBe("page");
		const acceptedCard = screen.getByLabelText("訂單 #023");
		expect(within(acceptedCard).getByText("雞排不要切")).toBeTruthy();
		expect(within(acceptedCard).getByRole("button", { name: "完成" })).toBeTruthy();
		expect(within(acceptedCard).queryByRole("button", { name: "拒單" })).toBeNull();
	});

	it("shows the production shortcut when accepting the last pending Order", async () => {
		vi.stubGlobal("fetch", createFetchMock());
		render(<MerchantView />);
		const card = await screen.findByLabelText("訂單 #023");
		await userEvent.click(within(card).getByRole("button", { name: "接單" }));

		await screen.findByText("目前沒有待接單");
		expect(screen.getByRole("button", { name: "查看製作中訂單" })).toBeTruthy();
	});

	it("uses an in-site reject dialog, sends nothing when cancelled, and keeps the rejected snapshot in history", async () => {
		const fetchMock = createFetchMock();
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		const card = await screen.findByLabelText("訂單 #023");

		await userEvent.click(within(card).getByRole("button", { name: "拒單" }));
		const firstDialog = screen.getByRole("dialog", { name: "確定拒絕這筆訂單？" });
		expect(within(firstDialog).getByText("拒單後，這筆訂單將不再製作。")).toBeTruthy();
		expect(firstDialog.textContent).not.toContain("order-023");
		await userEvent.click(within(firstDialog).getByRole("button", { name: "返回" }));
		expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/reject") && init?.method === "POST")).toHaveLength(0);
		expect(screen.getByLabelText("訂單 #023")).toBeTruthy();

		await userEvent.click(within(card).getByRole("button", { name: "拒單" }));
		await userEvent.click(within(screen.getByRole("dialog", { name: "確定拒絕這筆訂單？" })).getByRole("button", { name: "確認拒單" }));
		await screen.findByText("已拒單 #023");
		expect(screen.queryByRole("dialog", { name: "確定拒絕這筆訂單？" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "歷史訂單" }));
		const historyCard = screen.getByLabelText("訂單 #023");
		expect(within(historyCard).getByText("已拒單")).toBeTruthy();
		expect(within(historyCard).getByText("雞排不要切")).toBeTruthy();
	});

	it("reloads the authoritative status after a 409 and leaves the pending Order actionable", async () => {
		const fetchMock = createFetchMock({ orderActionStatus: 409 });
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		const card = await screen.findByLabelText("訂單 #023");

		await userEvent.click(within(card).getByRole("button", { name: "接單" }));
		await screen.findByText("#023 已被其他裝置更新，已重新同步最新狀態。");
		expect(within(screen.getByLabelText("訂單 #023")).getByRole("button", { name: "接單" })).toBeTruthy();
		expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/merchant/orders").length).toBeGreaterThan(1);
	});

	it("keeps existing cards visible while polling discovers a newer Order", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const first = order();
		const second = order({ id: "order-024", orderNumber: "024", estimatedReadyAt: "2026-09-16T12:20:00.000Z" });
		const incoming = order({ id: "order-020", orderNumber: "020", estimatedReadyAt: "2026-09-16T11:50:00.000Z" });
		vi.stubGlobal("fetch", createFetchMock({ orderPollSequence: [[first, second], [incoming, first, second]] }));
		render(<MerchantView />);
		await screen.findByLabelText("訂單 #023");

		await vi.advanceTimersByTimeAsync(10_100);
		expect(screen.getByLabelText("訂單 #023")).toBeTruthy();
		expect(screen.getByRole("button", { name: /待接單 3/ })).toBeTruthy();
	});

	it("targets the selected spice line for shortage and refreshes the shared Menu Item as sold out", async () => {
		const fetchMock = createFetchMock();
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		const card = await screen.findByLabelText("訂單 #023");
		const mediumGroup = within(card).getByRole("heading", { name: "中辣" }).closest("section");
		if (!mediumGroup) throw new Error("Missing medium-spice group");
		await userEvent.click(within(mediumGroup).getByRole("button", { name: "缺貨" }));
		const dialog = screen.getByRole("dialog", { name: "確認品項缺貨？" });
		expect(within(dialog).getByText(/香雞排/)).toBeTruthy();
		expect(within(dialog).queryByRole("combobox")).toBeNull();
		await userEvent.click(within(dialog).getByRole("button", { name: "確認缺貨並停售" }));
		await screen.findByText(/香雞排已停售/);

		const shortageCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/shortages"));
		expect(JSON.parse(String(shortageCall?.[1]?.body)).items).toEqual([
			{ orderItemId: "line-chicken-medium", quantity: 1 },
		]);
		await userEvent.click(within(screen.getByRole("navigation", { name: "店家主要功能" })).getByRole("button", { name: "售罄" }));
		expect(await screen.findByRole("button", { name: "恢復 香雞排" })).toBeTruthy();
	});

	it("persists large-text mode and keeps a long note visible", async () => {
		const longNote = "這是一段很長的訂單備註，請炸酥一點並確認每一項調味與切法都完整顯示，不可以截斷。";
		vi.stubGlobal("fetch", createFetchMock({ orders: [order({ customerNote: longNote })] }));
		render(<MerchantView />);
		await screen.findByText(longNote);

		await userEvent.click(screen.getByRole("button", { name: "大字模式" }));
		expect(document.querySelector(".merchant-page.large-text")).toBeTruthy();
		expect(localStorage.getItem("merchant-large-text")).toBe("true");
		expect(screen.getByText(longNote)).toBeTruthy();
	});

	it("lists products and uses only the narrow sold-out and restore endpoints", async () => {
		const fetchMock = createFetchMock();
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		await screen.findByLabelText("訂單 #023");
		const navigation = screen.getByRole("navigation", { name: "店家主要功能" });
		await userEvent.click(within(navigation).getByRole("button", { name: "售罄" }));

		expect(screen.getByText("香雞排")).toBeTruthy();
		expect(screen.getByText("青椒")).toBeTruthy();
		const soldOutRow = screen.getByRole("button", { name: "恢復 青椒" }).closest("li");
		expect(soldOutRow?.classList.contains("is-sold-out")).toBe(true);
		await userEvent.click(screen.getByRole("button", { name: "售罄 香雞排" }));
		const restoreChicken = await screen.findByRole("button", { name: "恢復 香雞排" });
		expect(restoreChicken.closest("li")?.classList.contains("is-sold-out")).toBe(true);
		await userEvent.click(screen.getByRole("button", { name: "恢復 香雞排" }));
		const sellOutChicken = await screen.findByRole("button", { name: "售罄 香雞排" });
		expect(sellOutChicken.closest("li")?.classList.contains("is-sold-out")).toBe(false);

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
		await screen.findByLabelText("訂單 #023");
		await userEvent.click(within(screen.getByRole("navigation", { name: "店家主要功能" })).getByRole("button", { name: "售罄" }));

		const quickSection = screen.getByRole("heading", { name: "快速售罄" }).closest("section");
		if (!quickSection) throw new Error("Missing quick-sold-out section");
		expect(within(quickSection).getByText("香雞排")).toBeTruthy();
		expect(within(quickSection).getByText("新品雞塊")).toBeTruthy();
		expect(within(quickSection).queryByText("青椒")).toBeNull();
		expect(screen.getAllByText("新品雞塊")).toHaveLength(2);
	});
});
