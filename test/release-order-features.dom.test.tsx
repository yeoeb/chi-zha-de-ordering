import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CustomerOrderStatus from "../src/react-app/CustomerOrderStatus";
import { MerchantOrderCard } from "../src/react-app/MerchantComponents";
import { CustomerHeader } from "../src/react-app/CustomerComponents";
import type { CustomerOrder } from "../src/react-app/order-status";
import type { MerchantOrder } from "../src/react-app/merchant-operations";

const token = "a".repeat(64);

function customerOrder(overrides: Partial<CustomerOrder> = {}): CustomerOrder {
	return {
		publicLookupToken: token,
		orderNumber: "CZ-001",
		status: "pending",
		orderSource: "online",
		customerName: "王小明",
		customerNote: "<img src=x onerror=alert(1)>",
		packagingPreference: "together",
		createdAt: "2026-09-25T03:50:00.000Z",
		estimatedReadyAt: new Date(Date.now() + 9 * 60_000).toISOString(),
		total: 100,
		originalTotal: 170,
		shortagePolicy: "continue_available",
		shortageRevision: 1,
		cancelledAt: null,
		cancellationReason: null,
		items: [{ name: "雞排", unitPrice: 100, quantity: 1, lineTotal: 100, modifiers: [] }],
		reorderItems: [{ menuItemId: 1, quantity: 1, modifierOptionIds: [] }],
		shortages: [{ name: "薯條", quantity: 1, amountDeducted: 70 }],
		...overrides,
	};
}

function merchantOrder(): MerchantOrder {
	return {
		id: "order-1", orderNumber: "CZ-MERCHANT-001", status: "pending", orderSource: "online",
		total: 170, originalTotal: 170, shortagePolicy: "continue_available", shortageRevision: 0,
		cancelledAt: null, cancellationReason: null,
		estimatedReadyAt: "2026-09-25T05:00:00.000Z", createdAt: "2026-09-25T04:00:00.000Z",
		customerName: "王小明", customerPhone: "0912345678", customerNote: null,
		packagingPreference: "together", specialOrder: false, shortages: [],
		items: [
			{ id: "line-a", menuItemId: 1, name: "雞排", quantity: 2, lineTotal: 140, modifiers: [] },
			{ id: "line-b", menuItemId: 9, name: "薯條", quantity: 1, lineTotal: 30, modifiers: [] },
		],
	};
}

beforeEach(() => {
	localStorage.clear();
	vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("release Customer and Merchant Order features", () => {
	it("shows an unread badge on the persistent My Orders entry", () => {
		render(<CustomerHeader
			displayName="吃炸的"
			isAcceptingOrders
			cartItemCount={0}
			onCartClick={() => undefined}
			hasUnreadOrderUpdate
			onOrdersClick={() => undefined}
		/>);
		expect(screen.getByRole("button", { name: "我的訂單，有未讀變更" })).toBeTruthy();
		expect(screen.getByText("!")).toBeTruthy();
	});

	it("renders authoritative accepting, paused, and unknown Customer Store states", () => {
		const props = {
			displayName: "吃炸的",
			cartItemCount: 2,
			onCartClick: () => undefined,
		};
		const { rerender } = render(<CustomerHeader {...props} isAcceptingOrders />);
		expect(screen.getByText("營業中・可接單").classList.contains("accepting")).toBe(true);
		const cartButton = screen.getByRole("button", { name: "購物車共 2 件" });
		expect(cartButton.classList.contains("header-cart-button")).toBe(true);
		expect(within(cartButton).getByText("2").classList.contains("cart-badge")).toBe(true);

		rerender(<CustomerHeader {...props} isAcceptingOrders={false} />);
		expect(screen.getByText("暫停接單").classList.contains("paused")).toBe(true);
		rerender(<CustomerHeader {...props} isAcceptingOrders={null} />);
		expect(screen.getByText("無法確認營業狀態").classList.contains("unknown")).toBe(true);
	});

	it("shows the adjusted payable amount, shortage history, countdown, and renders hostile notes as text", async () => {
		render(<CustomerOrderStatus publicLookupToken={token} initialOrder={customerOrder()} />);
		expect(document.body.textContent).not.toContain("CZ-001");
		for (const element of document.querySelectorAll("[aria-label], [title]")) {
			expect(`${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""}`).not.toContain("CZ-001");
		}
		const alert = screen.getByRole("alert");
		expect(within(alert).getByText("最新應付金額 NT$ 100")).toBeTruthy();
		expect(within(alert).getByText(/原價 NT\$ 170/)).toBeTruthy();
		expect(screen.getByText(/即將可以取餐/)).toBeTruthy();
		expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
		expect(document.querySelector("img")).toBeNull();
		await userEvent.click(within(alert).getByRole("button", { name: "我知道了" }));
		expect(screen.queryByText("部分餐點已售完")).toBeNull();
		expect(screen.getByText("餐點調整紀錄")).toBeTruthy();
	});

	it("requires cancellation confirmation and applies the authoritative cancelled snapshot", async () => {
		const cancelled = customerOrder({ status: "cancelled", total: 0, cancelledAt: new Date().toISOString(), cancellationReason: "customer_cancelled" });
		const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ order: cancelled }), { status: 200, headers: { "Content-Type": "application/json" } }));
		render(<CustomerOrderStatus publicLookupToken={token} initialOrder={customerOrder({ shortages: [], shortageRevision: 0, originalTotal: 100 })} />);
		await userEvent.click(screen.getByRole("button", { name: "取消訂單" }));
		const dialog = screen.getByRole("dialog", { name: "取消這筆訂單？" });
		expect(within(dialog).getByText("取消後無法復原。")).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledTimes(0);
		await userEvent.click(within(dialog).getByRole("button", { name: "取消訂單" }));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(await screen.findByRole("heading", { name: "訂單已取消" })).toBeTruthy();
		expect(screen.getByText("NT$ 0")).toBeTruthy();
	});

	it("targets one stable Order item and submits an exact partial shortage quantity", async () => {
		const onShortage = vi.fn(async () => true);
		render(<MerchantOrderCard order={merchantOrder()} isNew={false} isProcessing={false} onAction={() => undefined} onShortage={onShortage} />);
		expect(document.body.textContent).not.toContain("CZ-MERCHANT-001");
		for (const element of document.querySelectorAll("[aria-label], [title]")) {
			expect(`${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""}`).not.toContain("CZ-MERCHANT-001");
		}
		await userEvent.click(screen.getAllByRole("button", { name: "缺貨" })[0]!);
		const dialog = screen.getByRole("dialog", { name: "確認品項缺貨？" });
		expect(within(dialog).getByText(/雞排/)).toBeTruthy();
		await userEvent.selectOptions(within(dialog).getByRole("combobox"), "1");
		await userEvent.click(within(dialog).getByRole("button", { name: "確認缺貨並停售" }));
		expect(onShortage).toHaveBeenCalledWith([{ orderItemId: "line-a", quantity: 1 }]);
	});

	it("keeps the current Merchant total prominent and marks adjusted Orders briefly", () => {
		render(<MerchantOrderCard
			order={{
				...merchantOrder(),
				status: "accepted",
				total: 100,
				shortageRevision: 1,
				shortages: [{ orderItemId: "line-b", name: "薯條", quantity: 1, amountDeducted: 70 }],
			}}
			isNew={false}
			isProcessing={false}
			onAction={() => undefined}
		/>);
		expect(screen.getByText("NT$ 100")).toBeTruthy();
		expect(screen.getByText("已調整")).toBeTruthy();
		expect(screen.getByText("餐點調整")).toBeTruthy();
	});

	it("renders a hostile Customer note as text in the Merchant Order card", () => {
		const hostileNote = "<script>window.__merchant_xss = true</script>";
		render(<MerchantOrderCard
			order={{ ...merchantOrder(), customerNote: hostileNote }}
			isNew={false}
			isProcessing={false}
			onAction={() => undefined}
		/>);
		expect(screen.getByText(hostileNote)).toBeTruthy();
		expect(document.querySelector("script")).toBeNull();
	});
});
