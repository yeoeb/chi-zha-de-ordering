import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomerApp } from "../src/react-app/App";

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
	name: "地瓜薯條",
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
				{ id: 2, name: "小辣", priceDelta: 0 },
				{ id: 3, name: "中辣", priceDelta: 0 },
				{ id: 4, name: "大辣", priceDelta: 0 },
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
				{ id: 8, name: "小辣", priceDelta: 0 },
				{ id: 9, name: "中辣", priceDelta: 0 },
				{ id: 10, name: "大辣", priceDelta: 0 },
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
			});
		}
		if (url === "/api/orders") {
			const request = JSON.parse(String(init?.body)) as { customerName: string; customerNote: string | null };
			return json(
				{
					order: {
						publicLookupToken: "a".repeat(64),
						orderNumber: "CZ-TEST",
						status: "pending",
						customerName: request.customerName,
						customerNote: request.customerNote,
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
	await userEvent.click(screen.getByRole("button", { name: "下一步：確認訂單" }));
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
		if (!secondSection) throw new Error("Missing second category section");
		vi.spyOn(secondSection, "getBoundingClientRect").mockReturnValue({
			top: 900,
			bottom: 1200,
			height: 300,
			left: 0,
			right: 320,
			width: 320,
			x: 0,
			y: 900,
			toJSON: () => ({}),
		} as DOMRect);
		const scrollTabIntoView = vi.fn();
		Object.defineProperty(second, "scrollIntoView", { configurable: true, value: scrollTabIntoView });

		await userEvent.click(second);
		fireEvent.scroll(window);
		expect(second.getAttribute("aria-current")).toBe("true");
		expect(first.getAttribute("aria-current")).toBeNull();
		expect(window.scrollTo).toHaveBeenCalled();
		await waitFor(() => expect(scrollTabIntoView).toHaveBeenCalledWith(
			expect.objectContaining({ inline: "nearest" }),
		));
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
		await screen.findByRole("heading", { name: "結帳報價" });
		expect(fetchMock.mock.calls.some(([input]) => requestUrl(input as RequestInfo | URL) === "/api/checkout/quote")).toBe(true);
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
		expect(within(productCard("地瓜薯條")).getByLabelText("地瓜薯條 暫無圖片")).toBeTruthy();

		if (!friesImage) throw new Error("Missing configured product image");
		fireEvent.error(friesImage);
		await waitFor(() => expect(within(productCard("薯條")).getByLabelText("薯條 暫無圖片")).toBeTruthy());
		expect(productCard("薯條").querySelector(".product-image")).toBeNull();
	});

	it("shows the 熱門 badge only from API-backed presentation metadata", async () => {
		await renderCustomer([
			{ ...fries, isPopular: false },
			{ ...sweetPotatoFries, isPopular: true },
		]);
		expect(within(productCard("薯條")).queryByText("熱門")).toBeNull();
		expect(within(productCard("地瓜薯條")).getByText("熱門")).toBeTruthy();
	});

	it("keeps sold-out items visible, disabled, and after available items", async () => {
		await renderCustomer();
		const soldOutButton = screen.getByRole("button", { name: "加入 雞皮" }) as HTMLButtonElement;
		expect(soldOutButton.disabled).toBe(true);
		expect(within(productCard("雞皮")).getAllByText("售完")).toHaveLength(2);
		const cards = [...document.querySelectorAll(".product-card")];
		expect(cards.at(-1)).toBe(productCard("雞皮"));
	});

	it("shows the sticky cart bar when the cart becomes non-empty", async () => {
		await renderCustomer();
		expect(screen.queryByText("查看購物車")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		expect(screen.getByText("查看購物車")).toBeTruthy();
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
		const card = productCard("地瓜薯條");
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
		const sweetCard = productCard("地瓜薯條");
		await userEvent.click(within(friesCard).getByRole("button", { name: /調味：/ }));
		await userEvent.click(within(sweetCard).getByRole("button", { name: /調味：/ }));
		await userEvent.click(within(sweetCard).getByRole("radio", { name: "不加調味" }));

		expect((within(sweetCard).getByRole("radio", { name: "不加調味" }) as HTMLInputElement).checked).toBe(true);
		expect((within(friesCard).getByRole("radio", { name: "胡椒" }) as HTMLInputElement).checked).toBe(true);

		await userEvent.click(within(friesCard).getByRole("button", { name: "加入 薯條" }));
		await userEvent.click(within(sweetCard).getByRole("button", { name: "加入 地瓜薯條" }));
		await openCartView();
		const friesLine = screen.getByText("薯條 × 1").closest("li");
		const sweetLine = screen.getByText("地瓜薯條 × 1").closest("li");
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
		expect(within(card).getByText("熱門")).toBeTruthy();
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
		await screen.findByRole("heading", { name: "結帳報價" });
		const checkoutNote = screen.getByPlaceholderText("例如：辣／不辣分開裝、其他特殊需求") as HTMLTextAreaElement;
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
		await userEvent.click(screen.getByRole("button", { name: "中辣" }));

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
		expect(within(screen.getByText("香雞排 × 1").closest("li") as HTMLElement).getByRole("button", { name: /辣度：中辣/ })).toBeTruthy();
		expect(within(screen.getByText("鹹酥雞 × 1").closest("li") as HTMLElement).getByRole("button", { name: /辣度：大辣/ })).toBeTruthy();
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
		await userEvent.click(screen.getByRole("button", { name: "加入 地瓜薯條" }));
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
		await screen.findByRole("heading", { name: "結帳報價" });
		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		await userEvent.type(screen.getByLabelText("電話"), "0912345678");
		await userEvent.click(screen.getByRole("button", { name: "送出訂單" }));

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
		await screen.findByRole("heading", { name: "結帳報價" });
		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		await userEvent.type(screen.getByLabelText("電話"), "0912345678");
		await userEvent.type(
			screen.getByLabelText(/訂單備註/),
			"薯條不要鹽",
		);
		await userEvent.click(screen.getByRole("button", { name: "送出訂單" }));

		await waitFor(() => {
			const orderCall = fetchMock.mock.calls.find(
				([input]) => requestUrl(input as RequestInfo | URL) === "/api/orders",
			);
			expect(orderCall).toBeTruthy();
			const body = JSON.parse(String(orderCall?.[1]?.body));
			expect(body.customerNote).toBe("薯條不要鹽");
			expect(body.items).toEqual([
				{ menuItemId: 9, quantity: 1, modifierOptionIds: [15] },
			]);
		});
	});

	it("does not infer packaging notes and only performs phone format validation", async () => {
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
		await screen.findByRole("heading", { name: "結帳報價" });

		const phone = screen.getByLabelText("電話") as HTMLInputElement;
		expect(phone.pattern).toBe("[0-9+()\\-\\s]{7,30}");
		expect(document.body.textContent).not.toContain("已驗證");
		expect(document.body.textContent).not.toContain("驗證成功");
		expect(document.body.textContent).not.toContain("手機認證");
		expect(screen.getByText(/未特別註明則一起裝/)).toBeTruthy();

		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		await userEvent.type(phone, "0912345678");
		await userEvent.click(screen.getByRole("button", { name: "送出訂單" }));

		await waitFor(() => {
			const orderCall = fetchMock.mock.calls.find(
				([input]) => requestUrl(input as RequestInfo | URL) === "/api/orders",
			);
			expect(JSON.parse(String(orderCall?.[1]?.body)).customerNote).toBeNull();
		});
	});

	it("persists 辣粉另包 while keeping line spice and fries seasoning unchanged", async () => {
		const fetchMock = await renderCustomer([spicyChicken, fries]);
		await userEvent.click(screen.getByRole("button", { name: "加入 鹹酥雞" }));
		expect(screen.queryByRole("radio", { name: "辣粉另包" })).toBeNull();
		expect(screen.queryByRole("button", { name: "辣粉另包" })).toBeNull();
		await openCartView();
		const chickenLine = screen.getByText("鹹酥雞 × 1").closest("li");
		if (!chickenLine) throw new Error("Missing chicken line");
		await userEvent.click(within(chickenLine).getByRole("button", { name: /辣度：不辣/ }));
		await userEvent.click(within(chickenLine).getByRole("radio", { name: "中辣" }));
		await userEvent.click(screen.getByRole("button", { name: "← 繼續點餐" }));
		await userEvent.click(screen.getByRole("button", { name: "加入 薯條" }));
		await openCartView();

		const friesLine = screen.getByText("薯條 × 1").closest("li");
		if (!friesLine) throw new Error("Missing fries line");
		expect(within(friesLine).getByText("胡椒")).toBeTruthy();

		await userEvent.click(screen.getByRole("button", { name: "下一步：確認訂單" }));
		await screen.findByRole("heading", { name: "結帳報價" });
		await userEvent.click(screen.getByRole("checkbox", { name: "辣粉另包" }));
		await userEvent.type(screen.getByLabelText("姓名"), "王小明");
		await userEvent.type(screen.getByLabelText("電話"), "0912345678");
		await userEvent.click(screen.getByRole("button", { name: "送出訂單" }));

		await waitFor(() => {
			const quoteCall = fetchMock.mock.calls.find(
				([input]) => requestUrl(input as RequestInfo | URL) === "/api/checkout/quote",
			);
			const quoteBody = JSON.parse(String(quoteCall?.[1]?.body));
			expect(quoteBody.items).toEqual([
				{ menuItemId: 4, quantity: 1, modifierOptionIds: [9] },
				{ menuItemId: 9, quantity: 1, modifierOptionIds: [16] },
			]);

			const orderCall = fetchMock.mock.calls.find(
				([input]) => requestUrl(input as RequestInfo | URL) === "/api/orders",
			);
			const orderBody = JSON.parse(String(orderCall?.[1]?.body));
			expect(orderBody.customerNote).toBe("辣粉另包");
			expect(orderBody.items).toEqual(quoteBody.items);
		});
	});
});
