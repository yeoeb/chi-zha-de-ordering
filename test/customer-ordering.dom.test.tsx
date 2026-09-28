import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomerApp } from "../src/react-app/App";
import { CART_DRAFT_STORAGE_KEY, CART_DRAFT_TTL_MS } from "../src/react-app/cart-draft";
import {
	ORDER_ATTEMPT_STORAGE_KEY,
	ORDER_FORM_SESSION_KEY,
} from "../src/react-app/order-attempt";
import {
	ACTIVE_CUSTOMER_ORDER_STORAGE_KEY,
	CUSTOMER_ORDER_HISTORY_STORAGE_KEY,
} from "../src/react-app/active-customer-orders";

const appCss = readFileSync("src/react-app/App.css", "utf8");
const indexCss = readFileSync("src/react-app/index.css", "utf8");

type MenuItemFixture = {
	id: number;
	name: string;
	description: string;
	price: number;
	isAvailable: boolean;
	imageUrl?: string | null;
	isPopular?: boolean;
	isQuickSoldOut?: boolean;
	modifierGroups: Array<{
		id: number;
		name: string;
		selectionType: "single";
		isRequired: boolean;
		options: Array<{ id: number; name: string; priceDelta: number }>;
	}>;
};

const fries: MenuItemFixture = {
	id: 9,
	name: "薯條",
	description: "外酥內鬆",
	price: 40,
	isAvailable: true,
	modifierGroups: [
		{
			id: 5,
			name: "調味",
			selectionType: "single",
			isRequired: true,
			options: [
				{ id: 15, name: "梅粉", priceDelta: 0 },
				{ id: 16, name: "胡椒", priceDelta: 0 },
				{ id: 17, name: "不加調味", priceDelta: 0 },
			],
		},
	],
};

const sweetPotatoFries: MenuItemFixture = {
	id: 10,
	name: "甘梅地瓜",
	description: "香甜酥脆",
	price: 55,
	isAvailable: true,
	modifierGroups: [
		{
			id: 6,
			name: "調味",
			selectionType: "single",
			isRequired: true,
			options: [
				{ id: 18, name: "梅粉", priceDelta: 0 },
				{ id: 19, name: "胡椒", priceDelta: 0 },
				{ id: 20, name: "不加調味", priceDelta: 0 },
			],
		},
	],
};

const soldOutChicken: MenuItemFixture = {
	id: 3,
	name: "雞皮",
	description: "酥香",
	price: 45,
	isAvailable: false,
	modifierGroups: [],
};

const chickenCutlet: MenuItemFixture = {
	id: 1,
	name: "香雞排",
	description: "",
	price: 70,
	isAvailable: true,
	modifierGroups: [
		{
			id: 1,
			name: "辣度",
			selectionType: "single",
			isRequired: true,
			options: [
				{ id: 1, name: "不辣", priceDelta: 0 },
				{ id: 21, name: "微辣", priceDelta: 0 },
				{ id: 2, name: "小辣", priceDelta: 0 },
				{ id: 3, name: "中辣", priceDelta: 0 },
				{ id: 4, name: "大辣", priceDelta: 0 },
				{ id: 22, name: "辣粉另包", priceDelta: 0 },
			],
		},
		{
			id: 2,
			name: "切法",
			selectionType: "single",
			isRequired: true,
			options: [
				{ id: 5, name: "不切", priceDelta: 0 },
				{ id: 6, name: "切", priceDelta: 0 },
			],
		},
	],
};

const spicyChicken: MenuItemFixture = {
	id: 4,
	name: "鹹酥雞",
	description: "",
	price: 60,
	isAvailable: true,
	modifierGroups: [
		{
			id: 3,
			name: "辣度",
			selectionType: "single",
			isRequired: true,
			options: [
				{ id: 7, name: "不辣", priceDelta: 0 },
				{ id: 23, name: "微辣", priceDelta: 0 },
				{ id: 8, name: "小辣", priceDelta: 0 },
				{ id: 9, name: "中辣", priceDelta: 0 },
				{ id: 10, name: "大辣", priceDelta: 0 },
				{ id: 24, name: "辣粉另包", priceDelta: 0 },
			],
		},
	],
};

function json(value: unknown, status = 200) {
	return Promise.resolve(
		new Response(JSON.stringify(value), {
			status,
			headers: { "content-type": "application/json" },
		}),
	);
}

function requestUrl(input: RequestInfo | URL) {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

type MenuCategoryFixture = {
	id: number;
	name: string;
	items: MenuItemFixture[];
};

function createFetchMock(
	items: MenuItemFixture[] = [fries, sweetPotatoFries, soldOutChicken],
	categories: MenuCategoryFixture[] = [{ id: 1, name: "炸物", items }],
) {
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		if (url === "/api/store") {
			return json({ display_name: "吃炸的", is_accepting_orders: true });
		}
		if (url === "/api/menu") {
			return json({ categories });
		}
		if (url === "/api/checkout/quote") {
			const request = JSON.parse(String(init?.body)) as {
				items: Array<{ menuItemId: number; quantity: number; modifierOptionIds: number[] }>;
			};
			return json({
				items: request.items.map((line) => {
					const item = items.find((candidate) => candidate.id === line.menuItemId)!;
					const options = item.modifierGroups.flatMap((group) =>
						group.options
							.filter((option) => line.modifierOptionIds.includes(option.id))
							.map((option) => ({
								groupId: group.id,
								groupName: group.name,
								optionId: option.id,
								name: option.name,
								priceDelta: option.priceDelta,
							})),
					);
					return {
						menuItemId: item.id,
						name: item.name,
						quantity: line.quantity,
						unitPrice: item.price,
						lineTotal: item.price * line.quantity,
						modifiers: options,
					};
				}),
				total: request.items.reduce((total, line) => {
					const item = items.find((candidate) => candidate.id === line.menuItemId)!;
					return total + item.price * line.quantity;
				}, 0),
				estimatedReadyAt: "2026-09-16T05:30:00.000Z",
				leadMinutes: 15,
				quoteFingerprint: "c".repeat(64),
			});
		}
		if (url === "/api/orders") {
			const request = JSON.parse(String(init?.body)) as {
				customerName: string;
				customerNote: string | null;
				packagingPreference: "together" | "separate_spicy";
			};
			return json(
				{
					order: {
						publicLookupToken: "a".repeat(64),
						orderNumber: "CZ-TEST",
						status: "pending",
						customerName: request.customerName,
						customerNote: request.customerNote,
						packagingPreference: request.packagingPreference,
						createdAt: "2026-09-16T05:00:00.000Z",
						estimatedReadyAt: "2026-09-16T05:30:00.000Z",
						total: 40,
						items: [],
					},
				},
				201,
			);
		}
		throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
	});
}

async function renderCustomer(items?: MenuItemFixture[], categories?: MenuCategoryFixture[]) {
	const allItems = categories?.flatMap((category) => category.items) ?? items;
	const fetchMock = createFetchMock(allItems, categories);
	vi.stubGlobal("fetch", fetchMock);
	render(<CustomerApp />);
	await screen.findByRole("heading", { name: categories?.[0]?.name ?? "炸物" });
	return fetchMock;
}

async function openCartView() {
	await userEvent.click(screen.getByRole("button", { name: /購物車共 \d+ 件/ }));
	await screen.findByRole("heading", { name: "購物車" });
}

async function openCheckoutFromMenu() {
	await openCartView();
	await userEvent.click(screen.getByRole("button", { name: "去結帳" }));
}

function productCard(itemName: string) {
	const addButton = screen.getByRole("button", { name: `加入 ${itemName}` });
	const card = addButton.closest("li");
	if (!card) throw new Error(`Missing product card for ${itemName}`);
	return card;
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
	sessionStorage.clear();
});

describe("customer ordering redesign", () => {
	const categoryFixtures: MenuCategoryFixture[] = [
		{ id: 1, name: "香炸類", items: [fries] },
		{ id: 2, name: "點心類", items: [sweetPotatoFries] },
		{ id: 3, name: "蔬菜類", items: [soldOutChicken] },
	];

	it("marks the first category current initially and transfers current state on tap", async () => {
		vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
		await renderCustomer(undefined, categoryFixtures);
		const first = screen.getByRole("link", { name: "香炸類" });
		const second = screen.getByRole("link", { name: "點心類" });
		await waitFor(() => expect(first.getAttribute("aria-current")).toBe("true"));
		expect(second.getAttribute("aria-current")).toBeNull();
		const secondSection = document.getElementById("category-2");
		const firstSection = document.getElementById("category-1");
		const thirdSection = document.getElementById("category-3");
		if (!firstSection || !secondSection || !thirdSection) throw new Error("Missing category sections");
		const fixedRect = (top: number) => ({
			top, bottom: top + 300, height: 300, left: 0, right: 320, width: 320,
			x: 0, y: top, toJSON: () => ({}),
		}) as DOMRect;
		vi.spyOn(firstSection, "getBoundingClientRect").mockReturnValue(fixedRect(-500));
		vi.spyOn(thirdSection, "getBoundingClientRect").mockReturnValue(fixedRect(1_300));
		let secondTop = 900;
		vi.spyOn(secondSection, "getBoundingClientRect").mockImplementation(() => ({
			top: secondTop,
			bottom: secondTop + 300,
			height: 300,
			left: 0,
			right: 320,
			width: 320,
			x: 0,
			y: secondTop,
			toJSON: () => ({}),
		}) as DOMRect);
		const navigation = screen.getByRole("navigation", { name: "餐點分類" });
		Object.defineProperty(navigation, "clientWidth", { configurable: true, value: 100 });
		Object.defineProperty(second, "offsetLeft", { configurable: true, value: 120 });
		Object.defineProperty(second, "offsetWidth", { configurable: true, value: 50 });
		const horizontalScroll = vi.fn();
		Object.defineProperty(navigation, "scrollTo", { configurable: true, value: horizontalScroll });

		await userEvent.click(second);
		fireEvent.scroll(window);
		await waitFor(() => expect(second.getAttribute("aria-current")).toBe("true"));
		expect(first.getAttribute("aria-current")).toBeNull();
		expect(window.scrollTo).toHaveBeenCalled();
		await waitFor(() => expect(horizontalScroll).toHaveBeenCalledWith(
			expect.objectContaining({ left: 70 }),
		));
		secondTop = 10;
		fireEvent(window, new Event("scrollend"));
		expect(second.getAttribute("aria-current")).toBe("true");
	});

	it("keeps the third category active when its short section can only reach the page bottom", async () => {
		vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
		vi.spyOn(window, "scrollY", "get").mockReturnValue(1_000);
		vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
		vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(1_800);
		await renderCustomer(undefined, categoryFixtures);
		const sections = categoryFixtures.map((category) => document.getElementById(`category-${category.id}`));
		if (sections.some((section) => !section)) throw new Error("Missing category sections");
		const tops = [-900, -300, 420];
		sections.forEach((section, index) => {
			vi.spyOn(section!, "getBoundingClientRect").mockReturnValue({
				top: tops[index], bottom: tops[index] + 250, height: 250,
				left: 0, right: 320, width: 320, x: 0, y: tops[index], toJSON: () => ({}),
			} as DOMRect);
		});

		await userEvent.click(screen.getByRole("link", { name: "蔬菜類" }));
		fireEvent.scroll(window);
		fireEvent(window, new Event("scrollend"));
		expect(screen.getByRole("link", { name: "蔬菜類" }).getAttribute("aria-current")).toBe("true");
	});

	it("recomputes active category after content height changes and manual upward scrolling", async () => {
		let resizeCallback: ResizeObserverCallback = () => undefined;
		class ResizeObserverMock {
			constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
			observe() {}
			disconnect() {}
			unobserve() {}
		}
		vi.stubGlobal("ResizeObserver", ResizeObserverMock);
		await renderCustomer(undefined, categoryFixtures);
		const first = document.getElementById("category-1");
		const second = document.getElementById("category-2");
		const third = document.getElementById("category-3");
		if (!first || !second || !third) throw new Error("Missing category sections");
		let tops = [-500, -20, 500];
		[first, second, third].forEach((section, index) => {
			vi.spyOn(section, "getBoundingClientRect").mockImplementation(() => ({
				top: tops[index], bottom: tops[index] + 300, height: 300,
				left: 0, right: 320, width: 320, x: 0, y: tops[index], toJSON: () => ({}),
			}) as DOMRect);
		});
		fireEvent.scroll(window);
		await waitFor(() => expect(screen.getByRole("link", { name: "點心類" }).getAttribute("aria-current")).toBe("true"));
		tops = [-10, 400, 800];
		resizeCallback([], {} as ResizeObserver);
		fireEvent.scroll(window);
		await waitFor(() => expect(screen.getByRole("link", { name: "香炸類" }).getAttribute("aria-current")).toBe("true"));
	});

	it("updates the active category when manual scrolling crosses the sticky offset", async () => {
		await renderCustomer(undefined, categoryFixtures);
		const firstSection = document.getElementById("category-1");
		const secondSection = document.getElementById("category-2");
		const thirdSection = document.getElementById("category-3");
		if (!firstSection || !secondSection || !thirdSection) throw new Error("Missing category sections");
		const rect = (top: number, bottom: number) => ({
			top,
			bottom,
			height: bottom - top,
			left: 0,
			right: 320,
			width: 320,
			x: 0,
			y: top,
			toJSON: () => ({}),
		}) as DOMRect;
		vi.spyOn(firstSection, "getBoundingClientRect").mockReturnValue(rect(-500, -100));
		vi.spyOn(secondSection, "getBoundingClientRect").mockReturnValue(rect(-50, 350));
		vi.spyOn(thirdSection, "getBoundingClientRect").mockReturnValue(rect(400, 800));

		fireEvent.scroll(window);
		await waitFor(() => {
			expect(screen.getByRole("link", { name: "點心類" }).getAttribute("aria-current")).toBe("true");
			expect(screen.getByRole("link", { name: "香炸類" }).getAttribute("aria-current")).toBeNull();
		});
	});

	it("opens a dedicated Cart view from the header without embedding Cart in Menu", async () => {
		await renderCustomer();
		expect(screen.queryByRole("heading", { name: "購物車" })).toBeNull();
		expect(document.querySelector("#cart")).toBeNull();
		await openCartView();
		expect(screen.getByRole("button", { name: "← 繼續點餐" })).toBeTruthy();
		expect(screen.queryByText("查看購物車")).toBeNull();
	});

	it("opens Cart from the sticky CartBar and preserves lines after returning to Menu", async () => {
		await renderCustomer();
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		const cartBar = screen.getByText("查看購物車").closest("button");
		if (!cartBar) throw new Error("Missing CartBar button");
		await userEvent.click(cartBar);
		expect(screen.getByText("薯條 × 1")).toBeTruthy();
		expect(screen.getByText("胡椒")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "← 繼續點餐" }));
		expect(screen.queryByText("薯條 × 1")).toBeNull();
		await openCartView();
		expect(screen.getByText("薯條 × 1")).toBeTruthy();
		expect(screen.getByText("胡椒")).toBeTruthy();
	});

	it("requests an authoritative quote from Cart and returns Checkout back to Cart", async () => {
		const fetchMock = await renderCustomer();
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		await openCheckoutFromMenu();
		await screen.findByRole("heading", { name: "確認訂單" });
		expect(fetchMock.mock.calls.some(([input]) => requestUrl(input as RequestInfo | URL) === "/api/checkout/quote")).toBe(true);
		expect(screen.getByText("13:30")).toBeTruthy();
		expect(screen.queryByText("查看購物車")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "← 返回購物車" }));
		expect(screen.getByRole("heading", { name: "購物車" })).toBeTruthy();
		expect(screen.getByText("薯條 × 1")).toBeTruthy();
	});

	it("applies the white Customer page contract without changing role-specific page classes", async () => {
		await renderCustomer();
		expect(document.querySelector("main.customer-page")).toBeTruthy();
		expect(document.querySelector("main.customer-page")?.classList.contains("merchant-page")).toBe(false);
		expect(document.querySelector("main.customer-page")?.classList.contains("admin-page")).toBe(false);
		expect(indexCss).toMatch(/html,[\s\S]*body,[\s\S]*#root[\s\S]*background(?:-color)?:\s*#fff/i);
		expect(appCss).toMatch(/--customer-background:\s*#fff/i);
		expect(appCss).toMatch(/\.customer-page,[\s\S]*\.order-status-page[\s\S]*background:\s*var\(--customer-background\)/i);
		expect(appCss).toMatch(/\.order-note-field textarea[\s\S]*resize:\s*none/i);
		expect(document.querySelector(".header-cart-button svg.header-action-icon")).toBeTruthy();
	});

	it("keeps the price visible on every product card", async () => {
		await renderCustomer();
		expect(within(productCard("薯條")).getByText("NT$ 40")).toBeTruthy();
		expect(within(productCard("雞皮")).getByText("NT$ 45")).toBeTruthy();
	});

	it("uses configured image URLs and falls back safely when missing or broken", async () => {
		await renderCustomer([
			{ ...fries, imageUrl: "https://images.example.com/fries.jpg" },
			{ ...sweetPotatoFries, imageUrl: null },
		]);
		const friesImage = productCard("薯條").querySelector<HTMLImageElement>(".product-image");
		expect(friesImage?.getAttribute("src")).toBe("https://images.example.com/fries.jpg");
		expect(within(productCard("甘梅地瓜")).getByLabelText("甘梅地瓜 暫無圖片")).toBeTruthy();

		if (!friesImage) throw new Error("Missing configured product image");
		fireEvent.error(friesImage);
		await waitFor(() => expect(within(productCard("薯條")).getByLabelText("薯條 暫無圖片")).toBeTruthy());
		expect(productCard("薯條").querySelector(".product-image")).toBeNull();
	});

	it("shows the 熱門推薦 badge only from API-backed presentation metadata", async () => {
		await renderCustomer([
			{ ...fries, isPopular: false },
			{ ...sweetPotatoFries, isPopular: true },
		]);
		expect(within(productCard("薯條")).queryByText("熱門推薦")).toBeNull();
		expect(within(productCard("甘梅地瓜")).getByText("熱門推薦")).toBeTruthy();
	});

	it("keeps sold-out items visible, disabled, and after available items", async () => {
		await renderCustomer();
		const soldOutButton = screen.getByRole("button", { name: "加入 雞皮" }) as HTMLButtonElement;
		expect(soldOutButton.disabled).toBe(true);
		await userEvent.click(soldOutButton);
		expect(screen.queryByText("雞皮已加入購物車")).toBeNull();
		expect(within(productCard("雞皮")).getAllByText("已售完")).toHaveLength(2);
		expect(productCard("雞皮").classList.contains("sold-out")).toBe(true);
		const cards = [...document.querySelectorAll(".product-card")];
		expect(cards.at(-1)).toBe(productCard("雞皮"));
	});

	it("shows the sticky cart bar when the cart becomes non-empty", async () => {
		await renderCustomer();
		expect(screen.queryByText("查看購物車")).toBeNull();
		const addButton = screen.getByRole("button", { name: "加入 薯條" });
		await userEvent.click(addButton);
		expect(screen.getByText("薯條已加入購物車")).toBeTruthy();
		expect(addButton.textContent).toBe("✓");
		expect((addButton as HTMLButtonElement).disabled).toBe(false);
		expect(screen.getByRole("button", { name: "購物車共 1 件" })).toBeTruthy();
		expect(screen.getByText("查看購物車")).toBeTruthy();
	});

	it("keeps two rapid quick-add clicks and associates feedback with the correct products", async () => {
		await renderCustomer();
		const friesButton = screen.getByRole("button", { name: "加入 薯條" });
		friesButton.click();
		friesButton.click();
		await waitFor(() => expect(screen.getByRole("button", { name: "購物車共 2 件" })).toBeTruthy());
		expect(screen.getByText("薯條已加入購物車")).toBeTruthy();

		const sweetButton = screen.getByRole("button", { name: "加入 甘梅地瓜" });
		await userEvent.click(sweetButton);
		expect(screen.getByText("甘梅地瓜已加入購物車")).toBeTruthy();
		expect(friesButton.textContent).toBe("✓");
		expect(sweetButton.textContent).toBe("✓");
		expect(screen.getByRole("button", { name: "購物車共 3 件" })).toBeTruthy();

		await openCartView();
		expect(screen.getByText("薯條 × 2")).toBeTruthy();
		expect(screen.getByText("甘梅地瓜 × 1")).toBeTruthy();
	});

	it("does not show add success when the matching line is already at 99", async () => {
		localStorage.setItem(CART_DRAFT_STORAGE_KEY, JSON.stringify({
			version: 1,
			updatedAt: Date.now(),
			items: [{ menuItemId: 9, quantity: 99, modifierOptionIds: [16] }],
		}));
		await renderCustomer();
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		expect(screen.getByText("同一選項單筆最多 99 份，請先調整購物車。")).toBeTruthy();
		expect(screen.queryByText("薯條已加入購物車")).toBeNull();
		expect(screen.getByRole("button", { name: "購物車共 99 件" })).toBeTruthy();
	});

	it("quick-add uses defaults without expanding or opening customization", async () => {
		await renderCustomer();
		const card = productCard("薯條");
		const fold = within(card).getByRole("button", { name: /調味：胡椒/ });

		await userEvent.click(within(card).getByRole("button", { name: "加入 薯條" }));

		expect(fold.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("dialog")).toBeNull();
		await openCartView();
		const line = screen.getByText("薯條 × 1").closest("li");
		if (!line) throw new Error("Missing fries line");
		expect(within(line).getByText("胡椒")).toBeTruthy();
	});

	it("keeps inline options completely collapsed by default", async () => {
		await renderCustomer();
		const card = productCard("薯條");
		const toggle = within(card).getByRole("button", { name: /調味：胡椒/ });
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(within(card).queryByRole("radio", { name: "梅粉" })).toBeNull();
	});

	it("expands seasoning inline without creating a dialog or modal", async () => {
		await renderCustomer();
		const card = productCard("薯條");
		await userEvent.click(within(card).getByRole("button", { name: /調味：胡椒/ }));
		expect(within(card).getByRole("radio", { name: "梅粉" })).toBeTruthy();
		expect(screen.queryByRole("dialog")).toBeNull();
		await userEvent.click(within(card).getByRole("button", { name: /調味：胡椒/ }));
		expect(within(card).queryByRole("radio", { name: "梅粉" })).toBeNull();
	});

	it("defaults sweet potato fries seasoning to 梅粉", async () => {
		await renderCustomer();
		const card = productCard("甘梅地瓜");
		await userEvent.click(within(card).getByRole("button", { name: /調味：梅粉/ }));
		expect((within(card).getByRole("radio", { name: "梅粉" }) as HTMLInputElement).checked).toBe(true);
	});

	it("defaults fries seasoning to 胡椒", async () => {
		await renderCustomer();
		const card = productCard("薯條");
		await userEvent.click(within(card).getByRole("button", { name: /調味：胡椒/ }));
		expect((within(card).getByRole("radio", { name: "胡椒" }) as HTMLInputElement).checked).toBe(true);
	});

	it("changes only the targeted product selection state", async () => {
		await renderCustomer();
		const friesCard = productCard("薯條");
		const sweetCard = productCard("甘梅地瓜");
		await userEvent.click(within(friesCard).getByRole("button", { name: /調味：/ }));
		await userEvent.click(within(sweetCard).getByRole("button", { name: /調味：/ }));
		await userEvent.click(within(sweetCard).getByRole("radio", { name: "不加調味" }));

		expect((within(sweetCard).getByRole("radio", { name: "不加調味" }) as HTMLInputElement).checked).toBe(true);
		expect((within(friesCard).getByRole("radio", { name: "胡椒" }) as HTMLInputElement).checked).toBe(true);

		await userEvent.click(within(friesCard).getByRole("button", { name: "加入 薯條" }));
		await userEvent.click(within(sweetCard).getByRole("button", { name: "加入 甘梅地瓜" }));
		await openCartView();
		const friesLine = screen.getByText("薯條 × 1").closest("li");
		const sweetLine = screen.getByText("甘梅地瓜 × 1").closest("li");
		if (!friesLine || !sweetLine) throw new Error("Missing cart lines");
		expect(within(friesLine).getByText("胡椒")).toBeTruthy();
		expect(within(sweetLine).getByText("不加調味")).toBeTruthy();
	});

	it("changing seasoning creates a distinct cart-line identity", async () => {
		await renderCustomer();
		const card = productCard("薯條");
		await userEvent.click(within(card).getByRole("button", { name: "加入 薯條" }));
		await userEvent.click(within(card).getByRole("button", { name: /調味：胡椒/ }));
		await userEvent.click(within(card).getByRole("radio", { name: "梅粉" }));
		await userEvent.click(within(card).getByRole("button", { name: "加入 薯條" }));
		await openCartView();

		const lines = screen.getAllByText("薯條 × 1").map((heading) => heading.closest("li"));
		expect(lines).toHaveLength(2);
		expect(lines.some((line) => line && within(line).queryByText("胡椒"))).toBe(true);
		expect(lines.some((line) => line && within(line).queryByText("梅粉"))).toBe(true);
	});

	it("renders no seasoning group when zero items are applicable", async () => {
		await renderCustomer([
			{
				...fries,
				id: 1,
				name: "雞排",
				description: "大份量",
				price: 85,
				modifierGroups: [],
			},
		]);
		expect(screen.queryByRole("button", { name: /調味：/ })).toBeNull();
	});

	it("renders a newly API-created product with no modifiers as immediate quick-add", async () => {
		await renderCustomer([{
			id: 55,
			name: "新品雞塊",
			description: "",
			price: 55,
			isAvailable: true,
			isPopular: true,
			isQuickSoldOut: true,
			modifierGroups: [],
		}]);
		const card = productCard("新品雞塊");
		expect(within(card).getByText("熱門推薦")).toBeTruthy();
		expect(card.querySelector(".inline-option-group")).toBeNull();
		await userEvent.click(within(card).getByRole("button", { name: "加入 新品雞塊" }));
		await openCartView();
		expect(screen.getByText("新品雞塊 × 1")).toBeTruthy();
	});

	it("shows the order note only at checkout and sends seasoning in the quote", async () => {
		const fetchMock = await renderCustomer();
		expect(screen.queryByLabelText(/訂單備註/)).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		await openCheckoutFromMenu();
		await screen.findByRole("heading", { name: "確認訂單" });
		const checkoutNote = screen.getByPlaceholderText("例如：不放蒜頭、炸酥一點") as HTMLTextAreaElement;
		await userEvent.type(checkoutNote, "薯條不要鹽");
		expect(checkoutNote.value).toBe("薯條不要鹽");

		await waitFor(() => {
			const quoteCall = fetchMock.mock.calls.find(([input]) => requestUrl(input as RequestInfo | URL) === "/api/checkout/quote");
			expect(quoteCall).toBeTruthy();
			const body = JSON.parse(String(quoteCall?.[1]?.body));
			expect(body).toEqual({ items: [{ menuItemId: 9, quantity: 1, modifierOptionIds: [16] }] });
		});
	});

	it("changes spice inline on only the targeted cart line", async () => {
		await renderCustomer([
			{
				...fries,
				id: 4,
				name: "鹹酥雞",
				price: 70,
				modifierGroups: [
					{
						id: 3,
						name: "辣度",
						selectionType: "single",
						isRequired: true,
						options: [
							{ id: 7, name: "不辣", priceDelta: 0 },
							{ id: 8, name: "小辣", priceDelta: 0 },
							{ id: 9, name: "中辣", priceDelta: 0 },
							{ id: 10, name: "大辣", priceDelta: 0 },
						],
					},
				],
			},
		]);
		await userEvent.click(screen.getByRole("button", { name: "加入 鹹酥雞" }));
		await openCartView();
		const cartLine = screen.getByText("鹹酥雞 × 1").closest("li");
		if (!cartLine) throw new Error("Missing spicy cart line");
		const spiceFold = within(cartLine).getByRole("button", { name: /辣度：不辣/ });
		await userEvent.click(spiceFold);
		await userEvent.click(within(cartLine).getByRole("radio", { name: "小辣" }));

		expect(within(screen.getByText("鹹酥雞 × 1").closest("li") as HTMLElement).getByRole("button", { name: /辣度：小辣/ })).toBeTruthy();
	});

	it("keeps the same product with different spice in separate cart lines", async () => {
		await renderCustomer([spicyChicken]);
		await userEvent.click(screen.getByRole("button", { name: "加入 鹹酥雞" }));
		await openCartView();
		const firstLine = screen.getByText("鹹酥雞 × 1").closest("li");
		if (!firstLine) throw new Error("Missing first chicken line");
		await userEvent.click(within(firstLine).getByRole("button", { name: /辣度：不辣/ }));
		await userEvent.click(within(firstLine).getByRole("radio", { name: "中辣" }));
		await userEvent.click(screen.getByRole("button", { name: "← 繼續點餐" }));
		await userEvent.click(screen.getByRole("button", { name: "加入 鹹酥雞" }));
		await openCartView();

		const lines = screen.getAllByText("鹹酥雞 × 1").map((heading) => heading.closest("li"));
		expect(lines).toHaveLength(2);
		expect(lines.some((line) => line && within(line).queryByRole("button", { name: /辣度：中辣/ }))).toBe(true);
		expect(lines.some((line) => line && within(line).queryByRole("button", { name: /辣度：不辣/ }))).toBe(true);
	});

	it("bulk spice changes only spice on applicable lines and still allows line override", async () => {
		const chickenWithSpecial: MenuItemFixture = {
			...chickenCutlet,
			modifierGroups: [
				...chickenCutlet.modifierGroups,
				{
					id: 301,
					name: "特殊選項：不加醬",
					selectionType: "single",
					isRequired: false,
					options: [{ id: 3001, name: "不加醬", priceDelta: 0 }],
				},
			],
		};
		await renderCustomer([chickenWithSpecial, spicyChicken, fries]);
		const chickenCard = productCard("香雞排");
		await userEvent.click(within(chickenCard).getByRole("button", { name: /切法：不切/ }));
		await userEvent.click(within(chickenCard).getByRole("radio", { name: "切" }));
		await userEvent.click(within(chickenCard).getByRole("button", { name: "特殊選項（選填）" }));
		await userEvent.click(within(chickenCard).getByRole("checkbox", { name: "不加醬" }));
		await userEvent.click(within(chickenCard).getByRole("button", { name: "加入 香雞排" }));
		await userEvent.click(screen.getByRole("button", { name: "加入 鹹酥雞" }));
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		await openCartView();
		expect(screen.getByText("全部一致：不辣")).toBeTruthy();
		expect(screen.getByRole("button", { name: "不辣" }).getAttribute("aria-pressed")).toBe("true");
		await userEvent.click(screen.getByRole("button", { name: "中辣" }));
		expect(screen.getByText("已套用中辣")).toBeTruthy();
		expect(screen.getByRole("button", { name: "中辣" }).getAttribute("aria-pressed")).toBe("true");

		const cutletLine = screen.getByText("香雞排 × 1").closest("li");
		const spicyLine = screen.getByText("鹹酥雞 × 1").closest("li");
		const friesLine = screen.getByText("薯條 × 1").closest("li");
		if (!cutletLine || !spicyLine || !friesLine) throw new Error("Missing cart lines");
		expect(within(cutletLine).getByText("切 / 不加醬")).toBeTruthy();
		expect(within(cutletLine).getByRole("button", { name: /辣度：中辣/ })).toBeTruthy();
		expect(within(spicyLine).getByRole("button", { name: /辣度：中辣/ })).toBeTruthy();
		expect(within(friesLine).getByText("胡椒")).toBeTruthy();

		await userEvent.click(within(spicyLine).getByRole("button", { name: /辣度：中辣/ }));
		await userEvent.click(within(spicyLine).getByRole("radio", { name: "大辣" }));
		expect(screen.getByText("目前混合辣度")).toBeTruthy();
		expect(screen.getByRole("button", { name: "中辣" }).getAttribute("aria-pressed")).toBe("false");
		expect(within(screen.getByText("香雞排 × 1").closest("li") as HTMLElement).getByRole("button", { name: /辣度：中辣/ })).toBeTruthy();
		expect(within(screen.getByText("鹹酥雞 × 1").closest("li") as HTMLElement).getByRole("button", { name: /辣度：大辣/ })).toBeTruthy();
	});

	it("labels a partially supported bulk spice and leaves unsupported lines unchanged", async () => {
		const limitedChicken: MenuItemFixture = {
			...spicyChicken,
			id: 40,
			name: "限辣雞塊",
			modifierGroups: [{
				...spicyChicken.modifierGroups[0]!,
				id: 30,
				options: spicyChicken.modifierGroups[0]!.options
					.filter((option) => option.name !== "大辣")
					.map((option) => ({ ...option, id: option.id + 100 })),
			}],
		};
		await renderCustomer([chickenCutlet, limitedChicken]);
		await userEvent.click(screen.getByRole("button", { name: "加入 香雞排" }));
		await userEvent.click(screen.getByRole("button", { name: "加入 限辣雞塊" }));
		await openCartView();

		const partialButton = screen.getByRole("button", { name: "大辣（部分）" });
		expect(partialButton.title).toBe("部分商品沒有該選項");
		await userEvent.click(partialButton);
		expect(screen.getByText("已套用大辣；部分餐點不支援，未變更。")).toBeTruthy();
		expect(partialButton.getAttribute("aria-pressed")).toBe("false");
		const cutletLine = screen.getByText("香雞排 × 1").closest("li") as HTMLElement;
		const limitedLine = screen.getByText("限辣雞塊 × 1").closest("li") as HTMLElement;
		expect(within(cutletLine).getByRole("button", { name: /辣度：大辣/ })).toBeTruthy();
		expect(within(limitedLine).getByRole("button", { name: /辣度：不辣/ })).toBeTruthy();
	});

	it("rejects a bulk spice merge over 99 without changing quantities", async () => {
		localStorage.setItem(CART_DRAFT_STORAGE_KEY, JSON.stringify({
			version: 1,
			updatedAt: Date.now(),
			items: [
				{ menuItemId: 4, quantity: 60, modifierOptionIds: [7] },
				{ menuItemId: 4, quantity: 50, modifierOptionIds: [9] },
			],
		}));
		await renderCustomer([spicyChicken]);
		await openCartView();
		await userEvent.click(screen.getByRole("button", { name: "小辣" }));

		expect(screen.getByText("套用後相同餐點會超過單筆 99 份，未變更任何餐點。")).toBeTruthy();
		expect(screen.getByText("鹹酥雞 × 60")).toBeTruthy();
		expect(screen.getByText("鹹酥雞 × 50")).toBeTruthy();
		expect(screen.queryByText("鹹酥雞 × 110")).toBeNull();
		expect(screen.getByText("NT$ 6600")).toBeTruthy();
	});

	it("merges equalized spice lines without losing quantity or total", async () => {
		await renderCustomer([spicyChicken]);
		await userEvent.click(screen.getByRole("button", { name: "加入 鹹酥雞" }));
		await openCartView();
		const firstLine = screen.getByText("鹹酥雞 × 1").closest("li") as HTMLElement;
		await userEvent.click(within(firstLine).getByRole("button", { name: /辣度：不辣/ }));
		await userEvent.click(within(firstLine).getByRole("radio", { name: "中辣" }));
		await userEvent.click(screen.getByRole("button", { name: "← 繼續點餐" }));
		await userEvent.click(screen.getByRole("button", { name: "加入 鹹酥雞" }));
		await openCartView();
		expect(screen.getAllByText("鹹酥雞 × 1")).toHaveLength(2);

		await userEvent.click(screen.getByRole("button", { name: "小辣" }));
		const mergedLine = screen.getByText("鹹酥雞 × 2").closest("li") as HTMLElement;
		expect(screen.queryByText("鹹酥雞 × 1")).toBeNull();
		expect(within(mergedLine).getByText("NT$ 120")).toBeTruthy();
		expect(within(mergedLine).getByRole("button", { name: /辣度：小辣/ })).toBeTruthy();
	});

	it("serializes the default fries seasoning modifier into the quote", async () => {
		const fetchMock = await renderCustomer();
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		await openCheckoutFromMenu();
		await waitFor(() => {
			const quoteCall = fetchMock.mock.calls.find(([input]) => requestUrl(input as RequestInfo | URL) === "/api/checkout/quote");
			const body = JSON.parse(String(quoteCall?.[1]?.body));
			expect(body.items[0].modifierOptionIds).toEqual([16]);
		});
	});

	it("serializes the default sweet-potato seasoning modifier into the quote", async () => {
		const fetchMock = await renderCustomer();
		await userEvent.click(screen.getByRole("button", { name: "加入 甘梅地瓜" }));
		await openCheckoutFromMenu();
		await waitFor(() => {
			const quoteCall = fetchMock.mock.calls.find(
				([input]) => requestUrl(input as RequestInfo | URL) === "/api/checkout/quote",
			);
			const body = JSON.parse(String(quoteCall?.[1]?.body));
			expect(body.items[0].modifierOptionIds).toEqual([18]);
		});
	});

	it("quick-add persists the configured chicken cut default through quote and order", async () => {
		const fetchMock = await renderCustomer([chickenCutlet]);
		const card = productCard("香雞排");
		expect(within(card).getByRole("button", { name: /切法：不切/ })).toBeTruthy();
		await userEvent.click(within(card).getByRole("button", { name: "加入 香雞排" }));
		await openCheckoutFromMenu();
		await screen.findByRole("heading", { name: "確認訂單" });
		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		await userEvent.type(screen.getByLabelText("電話"), "0912345678");
		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));

		await waitFor(() => {
			const quoteCall = fetchMock.mock.calls.find(
				([input]) => requestUrl(input as RequestInfo | URL) === "/api/checkout/quote",
			);
			const orderCall = fetchMock.mock.calls.find(
				([input]) => requestUrl(input as RequestInfo | URL) === "/api/orders",
			);
			const expectedItems = [{ menuItemId: 1, quantity: 1, modifierOptionIds: [1, 5] }];
			expect(JSON.parse(String(quoteCall?.[1]?.body)).items).toEqual(expectedItems);
			expect(JSON.parse(String(orderCall?.[1]?.body)).items).toEqual(expectedItems);
		});
	});

	it("submits API-backed Special Options as modifierOptionIds", async () => {
		const specialItem: MenuItemFixture = {
			id: 44,
			name: "醬香炸物",
			description: "",
			price: 60,
			isAvailable: true,
			modifierGroups: [
				{
					id: 301,
					name: "特殊選項：不加醬",
					selectionType: "single",
					isRequired: false,
					options: [{ id: 3001, name: "不加醬", priceDelta: 0 }],
				},
				{
					id: 302,
					name: "特殊選項：醬另外放",
					selectionType: "single",
					isRequired: false,
					options: [{ id: 3002, name: "醬另外放", priceDelta: 0 }],
				},
			],
		};
		const fetchMock = await renderCustomer([specialItem]);
		const card = productCard("醬香炸物");
		await userEvent.click(within(card).getByRole("button", { name: "特殊選項（選填）" }));
		await userEvent.click(within(card).getByRole("checkbox", { name: "不加醬" }));
		await userEvent.click(within(card).getByRole("checkbox", { name: "醬另外放" }));
		expect(within(card).getByRole("button", { name: /特殊選項：已選 2 項/ })).toBeTruthy();
		await userEvent.click(within(card).getByRole("button", { name: "加入 醬香炸物" }));
		await openCheckoutFromMenu();

		await waitFor(() => {
			const quoteCall = fetchMock.mock.calls.find(
				([input]) => requestUrl(input as RequestInfo | URL) === "/api/checkout/quote",
			);
			expect(JSON.parse(String(quoteCall?.[1]?.body)).items).toEqual([
				{ menuItemId: 44, quantity: 1, modifierOptionIds: [3001, 3002] },
			]);
		});
	});

	it("does not expose a contradictory 原味 special option beside seasoning", async () => {
		await renderCustomer([
			{
				...fries,
				modifierGroups: [
					...fries.modifierGroups,
					{
						id: 7,
						name: "特殊選項：原味",
						selectionType: "single",
						isRequired: false,
						options: [{ id: 21, name: "原味", priceDelta: 0 }],
					},
				],
			},
		]);

		expect(screen.queryByRole("button", { name: /特殊選項/ })).toBeNull();
	});

	it("submits the selected seasoning and persisted order note", async () => {
		const fetchMock = await renderCustomer();
		const card = productCard("薯條");
		await userEvent.click(within(card).getByRole("button", { name: /調味：胡椒/ }));
		await userEvent.click(within(card).getByRole("radio", { name: "梅粉" }));
		await userEvent.click(within(card).getByRole("button", { name: "加入 薯條" }));
		await openCheckoutFromMenu();
		await screen.findByRole("heading", { name: "確認訂單" });
		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		await userEvent.type(screen.getByLabelText("電話"), "0912345678");
		await userEvent.type(
			screen.getByLabelText(/訂單備註/),
			"薯條不要鹽",
		);
		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));

		await waitFor(() => {
			const orderCall = fetchMock.mock.calls.find(
				([input]) => requestUrl(input as RequestInfo | URL) === "/api/orders",
			);
			expect(orderCall).toBeTruthy();
			const body = JSON.parse(String(orderCall?.[1]?.body));
			expect(body.customerNote).toBe("薯條不要鹽");
			expect(body.quoteFingerprint).toBe("c".repeat(64));
			expect(body.items).toEqual([
				{ menuItemId: 9, quantity: 1, modifierOptionIds: [15] },
			]);
		});
	});

	it("turns two synchronous submit clicks into one Order request", async () => {
		const fetchMock = await renderCustomer();
		await userEvent.click(within(productCard("薯條")).getByRole("button", { name: "加入 薯條" }));
		await openCheckoutFromMenu();
		await screen.findByRole("heading", { name: "確認訂單" });
		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		await userEvent.type(screen.getByLabelText("電話"), "0912345678");

		const submit = screen.getByRole("button", { name: "確認下單" });
		submit.click();
		submit.click();

		await screen.findByText("等待店家接單");
		expect(screen.getByText("13:30")).toBeTruthy();
		const orderCalls = fetchMock.mock.calls.filter(
			([input]) => requestUrl(input as RequestInfo | URL) === "/api/orders",
		);
		expect(orderCalls).toHaveLength(1);
		await userEvent.click(screen.getByRole("button", { name: "← 返回菜單" }));
		expect(screen.getByRole("heading", { name: "炸物" })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "我的訂單" }));
		expect(screen.getByRole("heading", { name: "我的訂單" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "查看訂單" })).toBeTruthy();
	});

	it("refreshes a changed quote without losing checkout fields and waits for explicit reconfirmation", async () => {
		const fetchMock = await renderCustomer();
		await userEvent.click(within(productCard("薯條")).getByRole("button", { name: "加入 薯條" }));
		await openCheckoutFromMenu();
		await screen.findByRole("heading", { name: "確認訂單" });
		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		await userEvent.type(screen.getByLabelText("電話"), "0912345678");
		await userEvent.type(screen.getByLabelText(/訂單備註/), "炸酥一點");

		const original = fetchMock.getMockImplementation();
		let orderAttempts = 0;
		const attemptKeys: string[] = [];
		fetchMock.mockImplementation(async (input, init) => {
			const url = requestUrl(input as RequestInfo | URL);
			if (url === "/api/orders") {
				orderAttempts += 1;
				attemptKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
				if (orderAttempts === 1) {
					return json({ error: { code: "QUOTE_CHANGED" } }, 409);
				}
			}
			if (url === "/api/checkout/quote" && orderAttempts === 1) {
				if (!original) throw new Error("Missing fetch implementation");
				const response = await original(input, init);
				const current = (await response.json()) as Record<string, unknown> & {
					items: Array<Record<string, unknown>>;
				};
				return json({
					...current,
					items: current.items.map((item) => ({ ...item, unitPrice: 45, lineTotal: 45 })),
					total: 45,
					quoteFingerprint: "d".repeat(64),
				});
			}
			if (!original) throw new Error("Missing fetch implementation");
			return original(input, init);
		});

		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));
		await screen.findByText("價格或餐點選項已更新，請確認新金額後再次確認下單。");
		expect(screen.getAllByText("NT$ 45")).toHaveLength(2);
		expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("王小明");
		expect((screen.getByLabelText("電話") as HTMLInputElement).value).toBe("0912345678");
		expect((screen.getByLabelText(/訂單備註/) as HTMLTextAreaElement).value).toBe("炸酥一點");
		expect(orderAttempts).toBe(1);

		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));
		await screen.findByText("等待店家接單");
		expect(orderAttempts).toBe(2);
		expect(attemptKeys[0]).not.toBe("");
		expect(attemptKeys[1]).not.toBe("");
		expect(attemptKeys[1]).not.toBe(attemptKeys[0]);
		const orderBodies = fetchMock.mock.calls
			.filter(([input]) => requestUrl(input as RequestInfo | URL) === "/api/orders")
			.map(([, init]) => JSON.parse(String(init?.body)) as { quoteFingerprint: string });
		expect(orderBodies.map((body) => body.quoteFingerprint)).toEqual([
			"c".repeat(64),
			"d".repeat(64),
		]);
	});

	it("treats 429 as a confirmed non-order and reports Retry-After", async () => {
		const fetchMock = await renderCustomer();
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		await openCheckoutFromMenu();
		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		await userEvent.type(screen.getByLabelText("電話"), "0912345678");
		const original = fetchMock.getMockImplementation();
		fetchMock.mockImplementation(async (input, init) => {
			if (requestUrl(input as RequestInfo | URL) === "/api/orders") {
				return Promise.resolve(new Response(
					JSON.stringify({ error: { code: "RATE_LIMITED" } }),
					{
						status: 429,
						headers: { "content-type": "application/json", "Retry-After": "45" },
					},
				));
			}
			if (!original) throw new Error("Missing fetch implementation");
			return original(input, init);
		});

		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));
		await screen.findByText("送單過於頻繁，本次未建立訂單。請於 45 秒後再試。");
		expect(localStorage.getItem(ORDER_ATTEMPT_STORAGE_KEY)).toBeNull();
		expect((screen.getByLabelText("姓名") as HTMLInputElement).disabled).toBe(false);
	});

	it("clears the pending attempt after a confirmed 422 rejection", async () => {
		const fetchMock = await renderCustomer();
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		await openCheckoutFromMenu();
		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		await userEvent.type(screen.getByLabelText("電話"), "0912345678");
		const original = fetchMock.getMockImplementation();
		fetchMock.mockImplementation(async (input, init) => {
			if (requestUrl(input as RequestInfo | URL) === "/api/orders") {
				return json({ error: { code: "UNAVAILABLE_ITEM" } }, 422);
			}
			if (!original) throw new Error("Missing fetch implementation");
			return original(input, init);
		});

		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));
		await screen.findByText("本次未建立訂單。餐點供應或選項可能已變更，請返回購物車確認後再試。");
		expect(localStorage.getItem(ORDER_ATTEMPT_STORAGE_KEY)).toBeNull();
		expect((screen.getByRole("button", { name: "← 返回購物車" }) as HTMLButtonElement).disabled).toBe(false);
	});

	it("uses explicit Taiwan mobile validation and removes order-level packaging choices", async () => {
		const fetchMock = await renderCustomer([spicyChicken]);
		await userEvent.click(screen.getByRole("button", { name: "加入 鹹酥雞" }));
		await openCartView();
		const firstLine = screen.getByText("鹹酥雞 × 1").closest("li");
		if (!firstLine) throw new Error("Missing first chicken line");
		await userEvent.click(within(firstLine).getByRole("button", { name: /辣度：不辣/ }));
		await userEvent.click(within(firstLine).getByRole("radio", { name: "中辣" }));
		await userEvent.click(screen.getByRole("button", { name: "← 繼續點餐" }));
		await userEvent.click(screen.getByRole("button", { name: "加入 鹹酥雞" }));
		await openCheckoutFromMenu();
		await screen.findByRole("heading", { name: "確認訂單" });

		const phone = screen.getByLabelText("電話") as HTMLInputElement;
		expect(phone.type).toBe("tel");
		expect(phone.inputMode).toBe("numeric");
		expect(phone.maxLength).toBe(10);
		expect(phone.hasAttribute("pattern")).toBe(false);
		expect(document.querySelectorAll(".required-label")).toHaveLength(2);
		expect(document.body.textContent).not.toContain("已驗證");
		expect(document.body.textContent).not.toContain("驗證成功");
		expect(document.body.textContent).not.toContain("手機認證");
		expect(screen.queryByRole("group", { name: "包裝方式" })).toBeNull();
		expect(screen.queryByRole("radio", { name: "一起裝" })).toBeNull();
		expect(screen.queryByRole("radio", { name: "辣／不辣分袋" })).toBeNull();
		expect(screen.queryByText(/包裝方式請使用上方選項/)).toBeNull();

		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		await userEvent.type(phone, "0912345678");
		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));

		await waitFor(() => {
			const orderCall = fetchMock.mock.calls.find(
				([input]) => requestUrl(input as RequestInfo | URL) === "/api/orders",
			);
			const body = JSON.parse(String(orderCall?.[1]?.body));
			expect(body.customerNote).toBeNull();
			expect(body.packagingPreference).toBe("together");
			expect(body.specialOrder).toBe(false);
		});
	});

	it("blocks an invalid phone before POST and clears the field error after correction", async () => {
		const fetchMock = await renderCustomer();
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		await openCheckoutFromMenu();
		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		const phone = screen.getByLabelText("電話") as HTMLInputElement;
		await userEvent.type(phone, "09123456");
		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));

		expect(await screen.findByText("請輸入 09 開頭的 10 位手機號碼")).toBeTruthy();
		expect(phone.getAttribute("aria-invalid")).toBe("true");
		expect(fetchMock.mock.calls.filter(
			([input]) => requestUrl(input as RequestInfo | URL) === "/api/orders",
		)).toHaveLength(0);

		await userEvent.clear(phone);
		await userEvent.type(phone, "0912345678");
		expect(screen.queryByText("請輸入 09 開頭的 10 位手機號碼")).toBeNull();
		expect(phone.getAttribute("aria-invalid")).toBe("false");
		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));
		await screen.findByText("等待店家接單");
		expect(fetchMock.mock.calls.filter(
			([input]) => requestUrl(input as RequestInfo | URL) === "/api/orders",
		)).toHaveLength(1);
	});

	it("maps a confirmed backend phone rejection to the field and permits a corrected retry", async () => {
		const fetchMock = await renderCustomer();
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		await openCheckoutFromMenu();
		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		const phone = screen.getByLabelText("電話") as HTMLInputElement;
		await userEvent.type(phone, "0912345678");

		const original = fetchMock.getMockImplementation();
		const attemptKeys: string[] = [];
		let orderAttempts = 0;
		fetchMock.mockImplementation(async (input, init) => {
			if (requestUrl(input as RequestInfo | URL) === "/api/orders") {
				orderAttempts += 1;
				attemptKeys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
				if (orderAttempts === 1) {
					return json({ error: { code: "INVALID_CUSTOMER_PHONE" } }, 400);
				}
			}
			if (!original) throw new Error("Missing fetch implementation");
			return original(input, init);
		});

		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));
		expect(await screen.findByText("請輸入 09 開頭的 10 位手機號碼")).toBeTruthy();
		expect(screen.queryByText(/餐點供應或選項可能已變更/)).toBeNull();

		await userEvent.clear(phone);
		await userEvent.type(phone, "0987654321");
		expect(screen.queryByText("請輸入 09 開頭的 10 位手機號碼")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));
		await screen.findByText("等待店家接單");
		expect(orderAttempts).toBe(2);
		expect(attemptKeys[0]).not.toBe("");
		expect(attemptKeys[1]).not.toBe("");
		expect(attemptKeys[1]).not.toBe(attemptKeys[0]);
	});

	it("persists 辣粉另包 as a per-line modifier while keeping fries seasoning unchanged", async () => {
		const fetchMock = await renderCustomer([spicyChicken, fries]);
		await userEvent.click(screen.getByRole("button", { name: "加入 鹹酥雞" }));
		await openCartView();
		const chickenLine = screen.getByText("鹹酥雞 × 1").closest("li");
		if (!chickenLine) throw new Error("Missing chicken line");
		await userEvent.click(within(chickenLine).getByRole("button", { name: /辣度：不辣/ }));
		await userEvent.click(within(chickenLine).getByRole("radio", { name: "辣粉另包" }));
		const packetLine = screen.getByText("鹹酥雞 × 1").closest("li");
		if (!packetLine) throw new Error("Missing reconfigured chicken line");
		expect(within(packetLine).getByRole("button", { name: /辣度：辣粉另包/ })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "← 繼續點餐" }));
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		await openCartView();

		const friesLine = screen.getByText("薯條 × 1").closest("li");
		if (!friesLine) throw new Error("Missing fries line");
		expect(within(friesLine).getByText("胡椒")).toBeTruthy();

		await userEvent.click(screen.getByRole("button", { name: "去結帳" }));
		await screen.findByRole("heading", { name: "確認訂單" });
		expect(screen.queryByRole("checkbox", { name: "辣粉另包" })).toBeNull();
		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		await userEvent.type(screen.getByLabelText("電話"), "0912345678");
		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));

		await waitFor(() => {
			const quoteCall = fetchMock.mock.calls.find(
				([input]) => requestUrl(input as RequestInfo | URL) === "/api/checkout/quote",
			);
			const quoteBody = JSON.parse(String(quoteCall?.[1]?.body));
			expect(quoteBody.items).toEqual([
				{ menuItemId: 4, quantity: 1, modifierOptionIds: [24] },
				{ menuItemId: 9, quantity: 1, modifierOptionIds: [16] },
			]);

			const orderCall = fetchMock.mock.calls.find(
				([input]) => requestUrl(input as RequestInfo | URL) === "/api/orders",
			);
			const orderBody = JSON.parse(String(orderCall?.[1]?.body));
			expect(orderBody.customerNote).toBeNull();
			expect(orderBody.items).toEqual(quoteBody.items);
		});
	});

	it("restores a versioned cart draft after menu validation without merging modifier identities", async () => {
		localStorage.setItem(CART_DRAFT_STORAGE_KEY, JSON.stringify({
			version: 1,
			updatedAt: Date.now(),
			items: [
				{ menuItemId: 4, quantity: 2, modifierOptionIds: [24] },
				{ menuItemId: 4, quantity: 1, modifierOptionIds: [8] },
			],
		}));
		await renderCustomer([spicyChicken]);
		await openCartView();
		const packetLine = screen.getByText("鹹酥雞 × 2").closest("li");
		const mildLine = screen.getByText("鹹酥雞 × 1").closest("li");
		if (!packetLine || !mildLine) throw new Error("Missing restored cart lines");
		expect(within(packetLine).getByRole("button", { name: /辣度：辣粉另包/ })).toBeTruthy();
		expect(within(mildLine).getByRole("button", { name: /辣度：小辣/ })).toBeTruthy();
		expect(screen.getByText(/已依最新菜單還原購物車/)).toBeTruthy();
	});

	it("stores only non-sensitive cart identifiers in the local draft", async () => {
		await renderCustomer([spicyChicken]);
		await userEvent.click(screen.getByRole("button", { name: "加入 鹹酥雞" }));
		await waitFor(() => expect(localStorage.getItem(CART_DRAFT_STORAGE_KEY)).not.toBeNull());
		const stored = JSON.parse(localStorage.getItem(CART_DRAFT_STORAGE_KEY)!);
		expect(Object.keys(stored).sort()).toEqual(["items", "updatedAt", "version"]);
		expect(stored.items).toEqual([{ menuItemId: 4, quantity: 1, modifierOptionIds: [7] }]);
		expect(JSON.stringify(stored)).not.toContain("鹹酥雞");
		expect(JSON.stringify(stored)).not.toContain("customerPhone");
		expect(JSON.stringify(stored)).not.toContain("idempotency");
	});

	it("ignores expired, unavailable, and invalid-option cart draft data", async () => {
		localStorage.setItem(CART_DRAFT_STORAGE_KEY, JSON.stringify({
			version: 1,
			updatedAt: Date.now() - CART_DRAFT_TTL_MS - 1,
			items: [{ menuItemId: 4, quantity: 1, modifierOptionIds: [24] }],
		}));
		await renderCustomer([spicyChicken]);
		expect(await screen.findByText("購物車草稿已過期，請重新選擇餐點。")).toBeTruthy();
		expect(localStorage.getItem(CART_DRAFT_STORAGE_KEY)).toBeNull();

		cleanup();
		localStorage.setItem(CART_DRAFT_STORAGE_KEY, JSON.stringify({
			version: 1,
			updatedAt: Date.now(),
			items: [
				{ menuItemId: 4, quantity: 1, modifierOptionIds: [9999] },
				{ menuItemId: 3, quantity: 1, modifierOptionIds: [] },
			],
		}));
		await renderCustomer([spicyChicken, soldOutChicken]);
		expect(await screen.findByText(/另有 2 筆失效餐點未還原/)).toBeTruthy();
		expect(screen.queryByText("查看購物車")).toBeNull();
	});

	it("keeps the full removed line for a short undo without duplicating a replacement line", async () => {
		const mutableChicken = structuredClone(spicyChicken);
		await renderCustomer([mutableChicken]);
		await userEvent.click(screen.getByRole("button", { name: "加入 鹹酥雞" }));
		await openCartView();
		let line = screen.getByText("鹹酥雞 × 1").closest("li");
		if (!line) throw new Error("Missing cart line");
		await userEvent.click(within(line).getByRole("button", { name: /辣度：不辣/ }));
		await userEvent.click(within(line).getByRole("radio", { name: "辣粉另包" }));
		line = screen.getByText("鹹酥雞 × 1").closest("li");
		if (!line) throw new Error("Missing reconfigured cart line");
		await userEvent.click(within(line).getByRole("button", { name: "增加 鹹酥雞 數量" }));
		await userEvent.click(within(line).getByRole("button", { name: "移除 鹹酥雞" }));
		expect(screen.getByText("已移除「鹹酥雞」")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "復原" }));
		const restored = screen.getByText("鹹酥雞 × 2").closest("li");
		if (!restored) throw new Error("Missing restored cart line");
		expect(within(restored).getByRole("button", { name: /辣度：辣粉另包/ })).toBeTruthy();

		await userEvent.click(within(restored).getByRole("button", { name: "移除 鹹酥雞" }));
		await userEvent.click(screen.getByRole("button", { name: "← 繼續點餐" }));
		await userEvent.click(screen.getByRole("button", { name: "加入 鹹酥雞" }));
		await openCartView();
		const replacement = screen.getByText("鹹酥雞 × 1").closest("li");
		if (!replacement) throw new Error("Missing replacement line");
		await userEvent.click(within(replacement).getByRole("button", { name: /辣度：不辣/ }));
		await userEvent.click(within(replacement).getByRole("radio", { name: "辣粉另包" }));
		await userEvent.click(screen.getByRole("button", { name: "復原" }));
		expect(screen.getByText("購物車已有相同餐點，未重複加入已移除的數量。")).toBeTruthy();
		expect(screen.getByText("鹹酥雞 × 1")).toBeTruthy();
	});

	it("removes all precisely identified invalid quote lines, preserves modifiers, and only re-quotes", async () => {
		const fetchMock = await renderCustomer([fries, sweetPotatoFries, chickenCutlet]);
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		await userEvent.click(screen.getByRole("button", { name: "加入 甘梅地瓜" }));
		await userEvent.click(screen.getByRole("button", { name: "加入 香雞排" }));

		const original = fetchMock.getMockImplementation();
		let quoteCalls = 0;
		fetchMock.mockImplementation(async (input, init) => {
			if (requestUrl(input as RequestInfo | URL) === "/api/checkout/quote") {
				quoteCalls += 1;
				if (quoteCalls === 1) {
					return json({ error: { code: "UNAVAILABLE_ITEM", lineIssues: [
						{ itemIndex: 0, menuItemId: 9, code: "UNAVAILABLE_ITEM" },
						{ itemIndex: 2, menuItemId: 1, code: "INACTIVE_MODIFIER_OPTION", modifierOptionId: 5 },
					] } }, 422);
				}
			}
			if (!original) throw new Error("Missing fetch implementation");
			return original(input, init);
		});

		await openCheckoutFromMenu();
		await screen.findByText("薯條 × 1：商品已售完");
		expect(screen.getByText("香雞排 × 1：餐點選項已停用")).toBeTruthy();
		expect(screen.getByText("甘梅地瓜 × 1")).toBeTruthy();
		expect(screen.getByText("梅粉")).toBeTruthy();
		expect(screen.getAllByText("NT$ 55")).toHaveLength(2);
		expect(quoteCalls).toBe(2);
		expect(fetchMock.mock.calls.some(([input]) => requestUrl(input as RequestInfo | URL) === "/api/orders")).toBe(false);
	});

	it("uses the quote request snapshot so an old invalid-line response cannot delete a changed Cart", async () => {
		const fetchMock = await renderCustomer([fries]);
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		let resolveQuote: ((response: Response) => void) | undefined;
		const original = fetchMock.getMockImplementation();
		fetchMock.mockImplementation(async (input, init) => {
			if (requestUrl(input as RequestInfo | URL) === "/api/checkout/quote") {
				return new Promise<Response>((resolve) => { resolveQuote = resolve; });
			}
			if (!original) throw new Error("Missing fetch implementation");
			return original(input, init);
		});

		await openCartView();
		await userEvent.click(screen.getByRole("button", { name: "去結帳" }));
		await screen.findByRole("heading", { name: "確認訂單" });
		await userEvent.click(screen.getByRole("button", { name: "← 返回購物車" }));
		await userEvent.click(screen.getByRole("button", { name: "增加 薯條 數量" }));
		resolveQuote?.(new Response(JSON.stringify({ error: {
			code: "UNAVAILABLE_ITEM",
			lineIssues: [{ itemIndex: 0, menuItemId: 9, code: "UNAVAILABLE_ITEM" }],
		} }), { status: 422, headers: { "content-type": "application/json" } }));

		await waitFor(() => expect(screen.getByText("薯條 × 2")).toBeTruthy());
		expect(screen.queryByText("薯條 × 1：商品已售完")).toBeNull();
	});

	it("removes only the invalid configuration when the same product has different modifiers", async () => {
		localStorage.setItem(CART_DRAFT_STORAGE_KEY, JSON.stringify({
			version: 1,
			updatedAt: Date.now(),
			items: [
				{ menuItemId: 1, quantity: 1, modifierOptionIds: [1, 5] },
				{ menuItemId: 1, quantity: 2, modifierOptionIds: [2, 5] },
			],
		}));
		const fetchMock = await renderCustomer([chickenCutlet]);
		await screen.findByText(/已依最新菜單還原購物車/);
		const original = fetchMock.getMockImplementation();
		let quoteCalls = 0;
		fetchMock.mockImplementation(async (input, init) => {
			if (requestUrl(input as RequestInfo | URL) === "/api/checkout/quote") {
				quoteCalls += 1;
				if (quoteCalls === 1) {
					return json({ error: { code: "INACTIVE_MODIFIER_OPTION", lineIssues: [
						{ itemIndex: 1, menuItemId: 1, code: "INACTIVE_MODIFIER_OPTION", modifierOptionId: 2 },
					] } }, 422);
				}
			}
			if (!original) throw new Error("Missing fetch implementation");
			return original(input, init);
		});

		await openCheckoutFromMenu();
		await screen.findByText("香雞排 × 2：餐點選項已停用");
		expect(screen.getByText("香雞排 × 1")).toBeTruthy();
		expect(screen.getByText("不辣 / 不切")).toBeTruthy();
		expect(screen.queryByText("小辣 / 不切")).toBeNull();
	});

	it("returns to an empty Cart when every quoted line is authoritatively invalid", async () => {
		const fetchMock = await renderCustomer([fries]);
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		const original = fetchMock.getMockImplementation();
		fetchMock.mockImplementation(async (input, init) => {
			if (requestUrl(input as RequestInfo | URL) === "/api/checkout/quote") {
				return json({ error: { code: "UNAVAILABLE_ITEM", lineIssues: [
					{ itemIndex: 0, menuItemId: 9, code: "UNAVAILABLE_ITEM" },
				] } }, 422);
			}
			if (!original) throw new Error("Missing fetch implementation");
			return original(input, init);
		});

		await openCheckoutFromMenu();
		await screen.findByText("尚未加入餐點");
		expect(screen.getByText("薯條 × 1：商品已售完")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "去結帳" })).toBeNull();
	});

	it("does not remove Cart lines for a quote rate limit", async () => {
		const fetchMock = await renderCustomer([fries]);
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		const original = fetchMock.getMockImplementation();
		fetchMock.mockImplementation(async (input, init) => {
			if (requestUrl(input as RequestInfo | URL) === "/api/checkout/quote") {
				return new Response(JSON.stringify({ error: { code: "RATE_LIMITED" } }), {
					status: 429,
					headers: { "content-type": "application/json", "Retry-After": "15" },
				});
			}
			if (!original) throw new Error("Missing fetch implementation");
			return original(input, init);
		});

		await openCheckoutFromMenu();
		await screen.findByText("報價請求過於頻繁，請於 15 秒後再試。");
		await userEvent.click(screen.getByRole("button", { name: "← 返回購物車" }));
		expect(screen.getByText("薯條 × 1")).toBeTruthy();
	});

	it("removes an invalid line rejected during Order creation without automatic resubmission", async () => {
		const fetchMock = await renderCustomer([fries, sweetPotatoFries]);
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		await userEvent.click(screen.getByRole("button", { name: "加入 甘梅地瓜" }));
		await openCheckoutFromMenu();
		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		await userEvent.type(screen.getByLabelText("電話"), "0912345678");
		await userEvent.type(screen.getByLabelText(/訂單備註/), "炸酥一點");
		const original = fetchMock.getMockImplementation();
		let orderCalls = 0;
		fetchMock.mockImplementation(async (input, init) => {
			if (requestUrl(input as RequestInfo | URL) === "/api/orders") {
				orderCalls += 1;
				return json({ error: { code: "UNAVAILABLE_ITEM", lineIssues: [
					{ itemIndex: 0, menuItemId: 9, code: "UNAVAILABLE_ITEM" },
				] } }, 422);
			}
			if (!original) throw new Error("Missing fetch implementation");
			return original(input, init);
		});

		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));
		await screen.findByText("薯條 × 1：商品已售完");
		expect(screen.getByText("甘梅地瓜 × 1")).toBeTruthy();
		expect((screen.getByLabelText("姓名") as HTMLInputElement).value).toBe("王小明");
		expect((screen.getByLabelText("電話") as HTMLInputElement).value).toBe("0912345678");
		expect((screen.getByLabelText(/訂單備註/) as HTMLTextAreaElement).value).toBe("炸酥一點");
		expect(orderCalls).toBe(1);
	});

	it("recovers the same pending Idempotency-Key after an uncertain response and reload", async () => {
		const fetchMock = await renderCustomer([spicyChicken]);
		await userEvent.click(screen.getByRole("button", { name: "加入 鹹酥雞" }));
		await waitFor(() => expect(localStorage.getItem(CART_DRAFT_STORAGE_KEY)).not.toBeNull());
		await openCheckoutFromMenu();
		await screen.findByRole("heading", { name: "確認訂單" });
		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		await userEvent.type(screen.getByLabelText("電話"), "0912345678");

		const original = fetchMock.getMockImplementation();
		let failedAttemptKey = "";
		fetchMock.mockImplementation(async (input, init) => {
			if (requestUrl(input as RequestInfo | URL) === "/api/orders") {
				failedAttemptKey = new Headers(init?.headers).get("Idempotency-Key") ?? "";
				return json({}, 503);
			}
			if (!original) throw new Error("Missing fetch implementation");
			return original(input, init);
		});
		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));
		await screen.findByRole("alert");
		expect(localStorage.getItem(CART_DRAFT_STORAGE_KEY)).not.toBeNull();
		expect(localStorage.getItem(ORDER_ATTEMPT_STORAGE_KEY)).not.toBeNull();
		expect(failedAttemptKey).not.toBe("");

		cleanup();
		const retryFetchMock = await renderCustomer([spicyChicken]);
		await screen.findByText(/已依最新菜單還原購物車/);
		await openCheckoutFromMenu();
		await screen.findByRole("heading", { name: "確認訂單" });
		const restoredName = screen.getByLabelText("姓名") as HTMLInputElement;
		const restoredPhone = screen.getByLabelText("電話") as HTMLInputElement;
		expect(restoredName.value).toBe("王小明");
		expect(restoredPhone.value).toBe("0912345678");
		expect(restoredName.disabled).toBe(true);
		expect(restoredPhone.disabled).toBe(true);
		expect(sessionStorage.getItem(ORDER_FORM_SESSION_KEY)).not.toBeNull();
		const retryOriginal = retryFetchMock.getMockImplementation();
		let recoveredAttemptKey = "";
		retryFetchMock.mockImplementation(async (input, init) => {
			if (requestUrl(input as RequestInfo | URL) === "/api/orders") {
				recoveredAttemptKey = new Headers(init?.headers).get("Idempotency-Key") ?? "";
				if (!retryOriginal) throw new Error("Missing retry fetch implementation");
				const replay = await retryOriginal(input, init);
				return new Response(await replay.text(), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (!retryOriginal) throw new Error("Missing retry fetch implementation");
			return retryOriginal(input, init);
		});
		await userEvent.click(screen.getByRole("button", { name: "確認下單" }));
		await screen.findByText("等待店家接單");
		expect(recoveredAttemptKey).toBe(failedAttemptKey);
		expect(localStorage.getItem(CART_DRAFT_STORAGE_KEY)).toBeNull();
		expect(localStorage.getItem(ORDER_ATTEMPT_STORAGE_KEY)).toBeNull();
	});

	it("separates active Orders from history and loads history only after the Customer opens it", async () => {
		const pendingToken = "a".repeat(64);
		const acceptedToken = "b".repeat(64);
		const completedToken = "c".repeat(64);
		localStorage.setItem(
			ACTIVE_CUSTOMER_ORDER_STORAGE_KEY,
			JSON.stringify([pendingToken, acceptedToken]),
		);
		localStorage.setItem(CUSTOMER_ORDER_HISTORY_STORAGE_KEY, JSON.stringify([completedToken]));
		const baseFetch = createFetchMock([fries]);
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = requestUrl(input);
			if (url.startsWith("/api/orders/by-token/")) {
				const token = decodeURIComponent(url.slice("/api/orders/by-token/".length));
				const status = token === pendingToken ? "pending" : token === acceptedToken ? "accepted" : "completed";
				return json({ order: {
					publicLookupToken: token,
					orderNumber: token === pendingToken ? "PENDING" : token === acceptedToken ? "ACCEPTED" : "DONE",
					status,
					customerName: "王小明",
					customerNote: null,
					packagingPreference: "together",
					createdAt: "2026-09-16T05:00:00.000Z",
					estimatedReadyAt: "2026-09-16T05:30:00.000Z",
					total: 40,
					items: token === completedToken ? [{
						name: "薯條", unitPrice: 35, quantity: 1, lineTotal: 35, modifiers: [{ groupName: "調味", name: "胡椒", priceDelta: 0 }],
					}] : [],
					reorderItems: token === completedToken ? [{ menuItemId: 9, quantity: 1, modifierOptionIds: [16] }] : [],
				} });
			}
			return baseFetch(input, init);
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<CustomerApp />);
		await screen.findByRole("heading", { name: "炸物" });
		const orderEntry = await screen.findByRole("button", { name: "我的訂單 2" });
		expect(fetchMock.mock.calls.some(([input]) => requestUrl(input as RequestInfo | URL).endsWith(completedToken))).toBe(false);

		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		expect(screen.getByRole("button", { name: "我的訂單 2" })).toBeTruthy();
		await userEvent.click(orderEntry);
		expect(screen.getAllByRole("button", { name: "查看訂單" })).toHaveLength(2);
		expect(screen.queryByText("餐點已完成")).toBeNull();
		await userEvent.click(screen.getAllByRole("button", { name: "查看訂單" })[0]!);
		expect(await screen.findByRole("button", { name: "← 返回我的訂單" })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "← 返回我的訂單" }));
		expect(screen.getByRole("heading", { name: "我的訂單" })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: /歷史訂單/ }));
		expect(await screen.findByRole("heading", { name: "歷史訂單" })).toBeTruthy();
		expect(await screen.findByText("餐點已完成")).toBeTruthy();
		expect(screen.getByText("9 月 16 日")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "查看明細" }));
		expect(await screen.findByRole("button", { name: "← 返回歷史訂單" })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "← 返回歷史訂單" }));
		expect(screen.getByRole("heading", { name: "歷史訂單" })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "再點一樣的" }));
		expect(screen.getByRole("heading", { name: "購物車" })).toBeTruthy();
		expect(screen.getByText("薯條 × 1")).toBeTruthy();
		expect(screen.getAllByText("NT$ 40").length).toBeGreaterThan(0);
		expect(screen.getByText("已依目前菜單與價格加入購物車，請重新確認後結帳。")).toBeTruthy();
		expect(fetchMock.mock.calls.some(([input]) => requestUrl(input as RequestInfo | URL).endsWith(completedToken))).toBe(true);
		expect(JSON.parse(localStorage.getItem(ACTIVE_CUSTOMER_ORDER_STORAGE_KEY) ?? "[]")).toEqual([
			pendingToken,
			acceptedToken,
		]);
	});
});
