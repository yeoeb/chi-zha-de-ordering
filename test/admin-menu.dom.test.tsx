import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/react-app/App";

const menuItem = {
	id: 1,
	categoryId: 1,
	categoryName: "雞排",
	name: "香雞排",
	description: "外酥內嫩",
	price: 80,
	sortOrder: 10,
	isAvailable: true,
	imageUrl: null,
	isPopular: false,
	isQuickSoldOut: false,
	isArchived: false,
	modifierGroups: [
		{
			id: 1,
			name: "辣度",
			isRequired: true,
			options: [
				{ id: 1, name: "不辣", priceDelta: 0 },
				{ id: 2, name: "小辣", priceDelta: 0 },
			],
		},
	],
};

function json(value: unknown, status = 200) {
	return Promise.resolve(new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	}));
}

function createAdminFetchMock() {
	let categories = [{ id: 1, name: "雞排", sortOrder: 1, isActive: true }];
	let items = [menuItem];
	return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";
		if (url === "/api/admin/menu" && method === "GET") {
			return json({ categories, items });
		}
		if (url === "/api/admin/store-presentation" && method === "GET") {
			return json({ originDisclosure: null });
		}
		if (url === "/api/admin/menu-items/1" && method === "PATCH") {
			const body = JSON.parse(String(init?.body));
			items = items.map((item) => item.id === 1 ? { ...item, ...body } : item);
			return json({ item: items[0] });
		}
		if (url === "/api/admin/menu-items" && method === "POST") {
			const body = JSON.parse(String(init?.body));
			const created = {
				...menuItem,
				...body,
				id: 2,
				categoryName: "雞排",
				description: body.description ?? "",
				sortOrder: body.sortOrder ?? 20,
				isAvailable: true,
				isArchived: false,
				modifierGroups: [],
			};
			items = [...items, created];
			return json({ item: created }, 201);
		}
		if (url === "/api/admin/categories" && method === "POST") {
			const body = JSON.parse(String(init?.body));
			const category = { id: 2, name: body.name.trim(), sortOrder: body.sortOrder ?? 11, isActive: true };
			categories = [...categories, category];
			return json({ category }, 201);
		}
		if (url === "/api/admin/categories/1" && method === "PATCH") {
			const body = JSON.parse(String(init?.body));
			categories = categories.map((category) => category.id === 1 ? { ...category, ...body } : category);
			return json({ category: categories[0] });
		}
		if (url === "/api/admin/store-presentation" && method === "PATCH") {
			return json(JSON.parse(String(init?.body)));
		}
		throw new Error(`Unexpected request: ${method} ${url}`);
	});
}

async function renderAdmin() {
	window.history.replaceState({}, "", "/admin/menu");
	const fetchMock = createAdminFetchMock();
	vi.stubGlobal("fetch", fetchMock);
	render(<App />);
	await screen.findByRole("heading", { name: "商品管理" });
	await screen.findByRole("heading", { name: "香雞排" });
	return fetchMock;
}

afterEach(() => {
	cleanup();
	window.history.replaceState({}, "", "/");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Admin menu UI", () => {
	it("renders only on the explicit Admin route with read-only modifier visibility", async () => {
		await renderAdmin();
		expect(screen.getByText("低頻設定；每日售罄請使用店家工作台。")).toBeTruthy();
		await userEvent.click(screen.getByText("餐點選項（唯讀）"));
		expect(screen.getByText("辣度")).toBeTruthy();
		expect(screen.getByText("不辣")).toBeTruthy();
		expect(screen.queryByText("接單")).toBeNull();
	});

	it("uses explicit Save and does not confirm an ordinary price change", async () => {
		const fetchMock = await renderAdmin();
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		await userEvent.click(screen.getByRole("button", { name: "編輯" }));
		const form = screen.getByLabelText("商品名稱").closest("form");
		if (!form) throw new Error("Missing Admin edit form");
		const price = within(form).getByLabelText("價格（TWD）");
		await userEvent.clear(price);
		await userEvent.type(price, "85");
		await userEvent.click(within(form).getByRole("button", { name: "儲存" }));

		await screen.findByText("香雞排 已儲存。");
		expect(confirm).not.toHaveBeenCalled();
		const patch = fetchMock.mock.calls.find(([input, init]) => input === "/api/admin/menu-items/1" && init?.method === "PATCH");
		expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({ price: 85 });
	});

	it("requires confirmation before an extreme price jump", async () => {
		const fetchMock = await renderAdmin();
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		await userEvent.click(screen.getByRole("button", { name: "編輯" }));
		const form = screen.getByLabelText("商品名稱").closest("form");
		if (!form) throw new Error("Missing Admin edit form");
		const price = within(form).getByLabelText("價格（TWD）");
		await userEvent.clear(price);
		await userEvent.type(price, "800");
		await userEvent.click(within(form).getByRole("button", { name: "儲存" }));

		expect(confirm).toHaveBeenCalledWith("價格將從 NT$ 80 改為 NT$ 800，確定儲存？");
		expect(fetchMock.mock.calls.some(([input, init]) => input === "/api/admin/menu-items/1" && init?.method === "PATCH")).toBe(false);
		expect((price as HTMLInputElement).value).toBe("800");
	});

	it("preserves the draft and exposes an error when a save fails", async () => {
		const fetchMock = await renderAdmin();
		fetchMock.mockImplementationOnce(async () => json({ error: { message: "後端拒絕更新" } }, 400));
		await userEvent.click(screen.getByRole("button", { name: "編輯" }));
		const name = screen.getByLabelText("商品名稱");
		const form = name.closest("form");
		if (!form) throw new Error("Missing Admin edit form");
		await userEvent.clear(name);
		await userEvent.type(name, "新雞排");
		await userEvent.click(within(form).getByRole("button", { name: "儲存" }));

		await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("後端拒絕更新"));
		expect((screen.getByLabelText("商品名稱") as HTMLInputElement).value).toBe("新雞排");
	});

	it("creates a product explicitly, refreshes authoritative data, and shows no empty modifier editor", async () => {
		const fetchMock = await renderAdmin();
		await userEvent.click(screen.getByRole("button", { name: "新增商品" }));
		const panel = screen.getByRole("heading", { name: "新增商品" }).closest("section");
		if (!panel) throw new Error("Missing create product panel");
		await userEvent.type(within(panel).getByLabelText("商品名稱"), "雞塊");
		await userEvent.type(within(panel).getByLabelText("價格（TWD）"), "55");
		await userEvent.selectOptions(within(panel).getByLabelText("分類"), "1");
		await userEvent.click(within(panel).getByLabelText("顧客熱門標記"));
		await userEvent.click(within(panel).getByLabelText("店家快速售罄"));
		await userEvent.click(within(panel).getByRole("button", { name: "新增商品" }));

		await screen.findByText("雞塊 已新增。");
		const newHeading = screen.getByRole("heading", { name: "雞塊" });
		const card = newHeading.closest("article");
		if (!card) throw new Error("Missing created product card");
		expect(within(card).getByText("客製選項：尚未設定")).toBeTruthy();
		expect(within(card).getByText("熱門")).toBeTruthy();
		expect(within(card).getByText("快速售罄")).toBeTruthy();
		const post = fetchMock.mock.calls.find(([input, init]) => input === "/api/admin/menu-items" && init?.method === "POST");
		expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
			name: "雞塊",
			price: 55,
			categoryId: 1,
			isPopular: true,
			isQuickSoldOut: true,
		});
		expect(fetchMock.mock.calls.filter(([input, init]) => input === "/api/admin/menu" && (init?.method ?? "GET") === "GET")).toHaveLength(2);
	});

	it("creates and renames categories with explicit saves", async () => {
		const fetchMock = await renderAdmin();
		await userEvent.click(screen.getByRole("button", { name: "管理分類" }));
		await userEvent.type(screen.getByLabelText("新分類名稱"), "點心");
		await userEvent.click(screen.getByRole("button", { name: "新增分類" }));
		await screen.findByText("分類已新增。");
		expect(screen.getByDisplayValue("點心")).toBeTruthy();

		const firstName = screen.getAllByLabelText("分類名稱")[0];
		await userEvent.clear(firstName);
		await userEvent.type(firstName, "招牌雞排");
		const row = firstName.closest("form");
		if (!row) throw new Error("Missing category editor");
		await userEvent.click(within(row).getByRole("button", { name: "儲存分類" }));
		await screen.findByText("招牌雞排 已儲存。");

		expect(fetchMock.mock.calls.some(([input, init]) => input === "/api/admin/categories" && init?.method === "POST")).toBe(true);
		expect(fetchMock.mock.calls.some(([input, init]) => input === "/api/admin/categories/1" && init?.method === "PATCH")).toBe(true);
	});
});
