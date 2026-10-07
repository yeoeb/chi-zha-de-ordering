import { readFileSync } from "node:fs";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BulkSpiceSelector, InlineFoldOptionGroup } from "../src/react-app/CustomerComponents";
import { MerchantOrderCard } from "../src/react-app/MerchantComponents";
import { groupMerchantItemsBySpice, type MerchantOrder } from "../src/react-app/merchant-operations";
import { spicePresentation, spiceSemanticClass } from "../src/react-app/spice-presentation";
import { syncCustomerStickyStack } from "../src/react-app/customer-scroll";

const css = readFileSync("src/react-app/App.css", "utf8");
const levels = ["不辣", "微辣", "小辣", "中辣", "大辣"];
function cssBlock(selector: string) {
	const start = css.indexOf(`${selector} {`);
	expect(start).toBeGreaterThanOrEqual(0);
	return css.slice(start, css.indexOf("}", start) + 1);
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("modifier and source visual semantics", () => {
	it.each(["online", "onsite"] as const)("keeps %s card, badge and accept action on the same source token", (source) => {
		const order: MerchantOrder = {
			id: "style-order", orderNumber: "023", status: "pending", orderSource: source,
			total: 90, estimatedReadyAt: "2026-10-07T11:20:00Z", createdAt: "2026-10-07T11:00:00Z",
			customerName: "測試", customerPhone: "", customerNote: null, packagingPreference: "together", specialOrder: false,
			items: levels.map((name) => ({ name: "餐點", quantity: 1, lineTotal: 18, modifiers: [{ groupName: "辣度", name }] })),
		};
		render(<MerchantOrderCard order={order} isNew isProcessing={false} onAction={vi.fn()} />);
		const card = screen.getByTestId("merchant-order-style-order");
		expect(card.classList.contains(`source-${source}`)).toBe(true);
		expect(within(card).getByText(source === "online" ? "網路" : "現場").classList.contains(`source-${source}`)).toBe(true);
		expect(within(card).getByRole("button", { name: "接單" }).classList.contains(`source-${source}`)).toBe(true);
		expect(within(card).getByRole("button", { name: "拒單" }).className).toBe("reject-button");
		const sourceStyle = cssBlock(`.merchant-order.source-${source}`);
		expect(sourceStyle).toContain(`--order-source-color: var(--source-${source})`);
		expect(sourceStyle).toContain(`border-color: var(--source-${source})`);
		expect(sourceStyle).toContain("border-left-width: 6px");
		expect(cssBlock(":root")).toContain("--source-online: #2563eb");
		expect(cssBlock(":root")).toContain("--source-onsite: #15803d");
		expect(cssBlock(".merchant-actions .accept-button.source-online,\n.merchant-actions .accept-button.source-onsite")).toContain("background: var(--order-source-color)");
		for (const name of levels) expect(within(card).getByRole("heading", { name }).closest("section")?.classList.contains(spiceSemanticClass(name))).toBe(true);
	});

	it("maps increasing spice intensity to increasingly strong red tints, independent of source", () => {
		const grouped = groupMerchantItemsBySpice(levels.map((name) => ({ name: "餐點", quantity: 1, lineTotal: 10, modifiers: [{ groupName: "辣度", name }] })));
		expect(grouped.map((group) => `spice-${group.className}`)).toEqual(levels.map(spiceSemanticClass));
		expect(levels.map((name) => spicePresentation[name]!.order)).toEqual([0, 1, 2, 3, 4]);
		const tints = levels.map((name) => cssBlock(`.${spiceSemanticClass(name)}`).match(/--spice-tint: #(\w{6})/)![1]!);
		expect(tints[0]).toBe("ffffff");
		const greenChannels = tints.map((tint) => Number.parseInt(tint.slice(2, 4), 16));
		for (let index = 1; index < greenChannels.length; index++) expect(greenChannels[index]!).toBeLessThan(greenChannels[index - 1]!);
		expect(cssBlock(".spice-none")).toContain("--spice-border: #374151");
		expect(cssBlock('.merchant-spice-group[class*="spice-"] > h3,\n.quote-spice-groups > section[class*="spice-"] > h3')).toContain("background: var(--spice-tint)");
	});

	it("retains spice classes for bulk controls and per-line folded/expanded choices", async () => {
		render(<><BulkSpiceSelector currentSummary="目前混合辣度" feedback={null} activeChoice={null}
			choiceAvailability={{ "不辣": "all", "微辣": "all", "小辣": "all", "中辣": "all", "大辣": "all", "辣粉另包": "all" }} onApply={vi.fn()} />
			<InlineFoldOptionGroup label="辣度" summary="辣度：中辣" mode="single" choices={levels.map((name) => ({ id: name, label: name, selected: name === "中辣" }))} onChange={vi.fn()} /></>);
		for (const name of levels) expect(screen.getByRole("button", { name }).classList.contains(spiceSemanticClass(name))).toBe(true);
		const toggle = screen.getByRole("button", { name: "辣度：中辣" });
		expect(toggle.classList.contains("spice-medium")).toBe(true);
		await userEvent.click(toggle);
		for (const name of levels) expect(screen.getByRole("radio", { name }).closest("label")?.classList.contains(spiceSemanticClass(name))).toBe(true);
	});
});

describe("customer category sticky offset contract", () => {
	it("measures both sticky heights, retains a shared 24px gap, and cannot accumulate scroll offsets", () => {
		render(<div className="customer-page" style={{ "--category-scroll-gap": "24px" } as React.CSSProperties}>
			<header className="customer-header" /><nav className="category-tabs" />
			<section className="category" id="category-3"><h2>蔬菜</h2></section>
		</div>);
		const rect = (height: number, top: number) => ({ height, top, bottom: top + height }) as DOMRect;
		const header = vi.spyOn(document.querySelector(".customer-header")!, "getBoundingClientRect").mockReturnValue(rect(96, 0));
		vi.spyOn(document.querySelector(".category-tabs")!, "getBoundingClientRect").mockReturnValue(rect(62, 96));
		expect(syncCustomerStickyStack()).toBe(182);
		header.mockReturnValue(rect(96, -500));
		expect(syncCustomerStickyStack()).toBe(182);
		expect(syncCustomerStickyStack()).toBe(182);
		header.mockReturnValue(rect(110, 0));
		expect(syncCustomerStickyStack()).toBe(196);
		expect(cssBlock(".category-tabs")).toContain("top: var(--customer-header-height)");
		expect(cssBlock(".customer-page .category")).toContain("scroll-margin-top: calc(var(--customer-header-height) + var(--customer-category-nav-height) + var(--category-scroll-gap))");
	});
});
