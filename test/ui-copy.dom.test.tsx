import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CustomerHeader } from "../src/react-app/CustomerComponents";
import { MerchantPrimaryNavigation } from "../src/react-app/MerchantComponents";
import { uiCopy } from "../src/react-app/ui-copy";

afterEach(cleanup);

describe("centralized presentation copy", () => {
	it("keeps the required role labels and pure ASCII-keyed string groups", () => {
		expect(Object.keys(uiCopy)).toEqual(["common", "customer", "onsite", "merchant"]);
		expect([
			uiCopy.merchant.pending, uiCopy.merchant.preparing, uiCopy.merchant.soldOut,
			uiCopy.merchant.accept, uiCopy.merchant.reject, uiCopy.merchant.complete,
			uiCopy.merchant.online, uiCopy.merchant.onsite,
		]).toEqual(["待接單", "製作中", "售罄", "接單", "拒單", "完成", "網路", "現場"]);
		for (const group of Object.values(uiCopy)) {
			for (const [key, value] of Object.entries(group)) {
				expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
				expect(typeof value).toBe("string");
				expect(value.trim().length).toBeGreaterThan(0);
			}
		}
	});

	it.each(["online", "onsite"] as const)("preserves %s header text, dynamic Store data and accessible names", (orderMode) => {
		render(<CustomerHeader displayName="測試店名（API 資料）" isAcceptingOrders cartItemCount={3}
			onCartClick={() => {}} onOrdersClick={() => {}} activeOrderCount={2} hasUnreadOrderUpdate orderMode={orderMode} />);
		expect(screen.getByRole("heading", { name: "測試店名（API 資料）" })).toBeTruthy();
		expect(screen.getByText(orderMode === "online" ? "現點現炸" : "現場點餐")).toBeTruthy();
		expect(screen.getByText("營業中・可接單")).toBeTruthy();
		expect(screen.getByRole("button", { name: "我的訂單 2，有未讀變更" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "購物車共 3 件" })).toBeTruthy();
	});

	it("preserves Merchant tab names, counts, active state and existing semantic classes", () => {
		render(<MerchantPrimaryNavigation activeView="orders" workflowView="pending" pendingCount={2} acceptedCount={3} onChange={() => {}} />);
		expect(screen.getByRole("navigation", { name: "店家主要功能" }).className).toBe("merchant-primary-nav");
		expect(screen.getByRole("button", { name: "待接單 2" }).getAttribute("aria-current")).toBe("page");
		expect(screen.getByRole("button", { name: "製作中 3" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "售罄" })).toBeTruthy();
	});
});
