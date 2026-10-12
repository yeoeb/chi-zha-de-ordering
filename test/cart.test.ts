import { describe, expect, it } from "vitest";
import { getDefaultOptionIds, getSpiceGroup, hasValidSpiceSelection, toSelectedModifier, type MenuItem } from "../src/react-app/customer-menu";
import { restoreCartDraft, serializeCartDraft } from "../src/react-app/cart-draft";
import {
	calculateUnitPrice,
	cartReducer,
	createCartLine,
	getCartLineSubtotal,
	getCartTotal,
	getCartItemCount,
	toCheckoutItems,
	MAX_CART_LINE_QUANTITY,
	reconfigureCartLines,
	type CartLine,
	type SelectedModifier,
} from "../src/react-app/cart";

const item = { id: 1, name: "雞排", price: 85 };
const mild: SelectedModifier = {
	groupId: 10,
	groupName: "辣度",
	optionId: 101,
	optionName: "小辣",
	priceDelta: 5,
};
const notSpicy: SelectedModifier = {
	...mild,
	optionId: 100,
	optionName: "不辣",
	priceDelta: 0,
};
const verySpicy: SelectedModifier = {
	...mild,
	optionId: 104,
	optionName: "大辣",
	priceDelta: 0,
};
const pepperPacket: SelectedModifier = {
	...mild,
	optionId: 105,
	optionName: "辣粉另包",
	priceDelta: 0,
};
const sliced: SelectedModifier = {
	groupId: 20,
	groupName: "切法",
	optionId: 201,
	optionName: "切",
	priceDelta: 0,
};
const notSliced: SelectedModifier = {
	...sliced,
	optionId: 202,
	optionName: "不切",
};
const pepperSeasoning: SelectedModifier = {
	groupId: 30,
	groupName: "調味",
	optionId: 301,
	optionName: "胡椒",
	priceDelta: 0,
};
const plumSeasoning: SelectedModifier = {
	...pepperSeasoning,
	optionId: 302,
	optionName: "梅粉",
};

describe("cart identity and transitions", () => {
	it("merges the same item configuration", () => {
		const line = createCartLine(item, [mild, sliced]);
		const sameConfiguration = createCartLine(item, [sliced, mild]);
		const once = cartReducer([], { type: "add", line });
		const twice = cartReducer(once, { type: "add", line: sameConfiguration });

		expect(sameConfiguration.id).toBe(line.id);
		expect(twice).toHaveLength(1);
		expect(twice[0]?.quantity).toBe(2);
	});

	it("keeps different modifier configurations as separate lines", () => {
		const slicedLine = createCartLine(item, [mild, sliced]);
		const notSlicedLine = createCartLine(item, [mild, notSliced]);
		const cart = cartReducer(cartReducer([], { type: "add", line: slicedLine }), {
			type: "add",
			line: notSlicedLine,
		});

		expect(slicedLine.id).not.toBe(notSlicedLine.id);
		expect(cart).toHaveLength(2);
	});

	it("keeps different API spice selections as separate lines", () => {
		const mildLine = createCartLine(item, [mild, sliced]);
		const hotLine = createCartLine(item, [verySpicy, sliced]);
		const cart = cartReducer(cartReducer([], { type: "add", line: mildLine }), {
			type: "add",
			line: hotLine,
		});

		expect(mildLine.id).not.toBe(hotLine.id);
		expect(cart).toHaveLength(2);
	});

	it("keeps 辣粉另包 mutually exclusive in line identity", () => {
		const mildLine = createCartLine(item, [mild, sliced]);
		const packetLine = createCartLine(item, [pepperPacket, sliced]);
		expect(packetLine.id).not.toBe(mildLine.id);
		expect(packetLine.selectedModifiers.filter((modifier) => modifier.groupId === mild.groupId)).toEqual([
			pepperPacket,
		]);
	});

	it("reconfigures only the targeted line and merges when persisted modifiers become identical", () => {
		const mildLine = createCartLine(item, [mild, sliced]);
		const plainLine = createCartLine(item, [notSpicy, sliced]);
		const cart = cartReducer(cartReducer([], { type: "add", line: mildLine }), {
			type: "add",
			line: plainLine,
		});
		const changed = cartReducer(cart, {
			type: "reconfigure",
			lineId: mildLine.id,
			selectedModifiers: [verySpicy, sliced],
		});

		expect(changed).toHaveLength(2);
		expect(changed.find((line) => line.id === plainLine.id)?.selectedModifiers).toContainEqual(notSpicy);

		const merged = cartReducer(changed, {
			type: "reconfigure",
			lineId: changed.find((line) => line.id !== plainLine.id)!.id,
			selectedModifiers: [notSpicy, sliced],
		});
		expect(merged).toHaveLength(1);
		expect(merged[0]?.quantity).toBe(2);
	});

	it("bulk reconfiguration preserves non-spice modifiers and merges all quantities", () => {
		const mildLine: CartLine = { ...createCartLine(item, [mild, sliced]), quantity: 2 };
		const hotLine: CartLine = { ...createCartLine(item, [verySpicy, sliced]), quantity: 3 };
		const result = reconfigureCartLines([mildLine, hotLine], [
			{ lineId: mildLine.id, selectedModifiers: [notSpicy, sliced] },
			{ lineId: hotLine.id, selectedModifiers: [notSpicy, sliced] },
		]);

		expect(result.exceededQuantityLimit).toBe(false);
		expect(result.lines).toHaveLength(1);
		expect(result.lines[0]).toMatchObject({ quantity: 5, unitPrice: 85 });
		expect(result.lines[0]?.selectedModifiers).toEqual([notSpicy, sliced]);
	});

	it("rejects an all-line spice merge that would exceed the backend line limit", () => {
		const mildLine: CartLine = { ...createCartLine(item, [mild, sliced]), quantity: 60 };
		const hotLine: CartLine = { ...createCartLine(item, [verySpicy, sliced]), quantity: 50 };
		const original = [mildLine, hotLine];
		const result = reconfigureCartLines(original, [
			{ lineId: mildLine.id, selectedModifiers: [notSpicy, sliced] },
			{ lineId: hotLine.id, selectedModifiers: [notSpicy, sliced] },
		]);

		expect(result).toEqual({ lines: original, exceededQuantityLimit: true });
		expect(getCartTotal(result.lines)).toBe(getCartTotal(original));
		expect(result.lines.reduce((total, line) => total + line.quantity, 0)).toBe(110);
	});

	it("never increases an existing cart line beyond 99", () => {
		const line: CartLine = {
			...createCartLine(item, [mild, sliced]),
			quantity: MAX_CART_LINE_QUANTITY,
		};

		expect(cartReducer([line], { type: "increase", lineId: line.id })).toEqual([line]);
		expect(cartReducer([line], { type: "add", line })).toEqual([line]);
	});

	it("keeps API-backed seasoning selections in cart-line identity without affecting price", () => {
		const pepper = createCartLine(item, [mild, pepperSeasoning]);
		const plum = createCartLine(item, [mild, plumSeasoning]);
		const cart = cartReducer(cartReducer([], { type: "add", line: pepper }), {
			type: "add",
			line: plum,
		});

		expect(pepper.id).not.toBe(plum.id);
		expect(pepper.unitPrice).toBe(plum.unitPrice);
		expect(cart).toHaveLength(2);
	});

	it("decreases 2 to 1 to 0 and preserves the same full line for recovery", () => {
		const line = createCartLine(item, [mild, sliced]);
		const one = cartReducer([], { type: "add", line });
		const two = cartReducer(one, { type: "increase", lineId: line.id });
		const backToOne = cartReducer(two, { type: "decrease", lineId: line.id });
		const removedAtZero = cartReducer(backToOne, { type: "decrease", lineId: line.id });

		expect(two[0]?.quantity).toBe(2);
		expect(backToOne[0]?.quantity).toBe(1);
		expect(removedAtZero).toEqual([{ ...line, quantity: 0 }]);
		expect(cartReducer(removedAtZero, { type: "decrease", lineId: line.id })).toEqual(removedAtZero);
		expect(cartReducer(removedAtZero, { type: "increase", lineId: line.id })).toEqual(one);
		expect(cartReducer(removedAtZero, { type: "add", line })).toEqual(one);
	});

	it("excludes zero lines from count, total and the shared quote/order payload", () => {
		const zero = { ...createCartLine(item, [mild, sliced, pepperSeasoning]), quantity: 0 };
		const active = { ...createCartLine(item, [notSpicy, sliced]), quantity: 2 };
		expect(getCartItemCount([zero, active])).toBe(2);
		expect(getCartTotal([zero, active])).toBe(170);
		expect(toCheckoutItems([zero, active])).toEqual([{ menuItemId: 1, quantity: 2, modifierOptionIds: [100, 201] }]);
		expect(getCartTotal([zero])).toBe(0);
		expect(getCartItemCount([zero])).toBe(0);
		expect(toCheckoutItems([zero])).toEqual([]);
	});

	it("never changes zero lines during spice reconfiguration or loses their identity through a merge", () => {
		const zero = { ...createCartLine(item, [mild, sliced, pepperSeasoning]), quantity: 0 };
		const active = { ...createCartLine(item, [verySpicy, sliced]), quantity: 2 };
		const changed = reconfigureCartLines([zero, active], [
			{ lineId: zero.id, selectedModifiers: [notSpicy, sliced, pepperSeasoning] },
			{ lineId: active.id, selectedModifiers: [notSpicy, sliced] },
		]);
		expect(changed.lines[0]).toBe(zero);
		expect(changed.lines[1]).toMatchObject({ quantity: 2, selectedModifiers: [notSpicy, sliced] });
		const matchingZero = { ...createCartLine(item, [notSpicy, sliced]), quantity: 0 };
		const refused = reconfigureCartLines([matchingZero, active], [{ lineId: active.id, selectedModifiers: [notSpicy, sliced] }]);
		expect(refused.zeroLineConflict).toBe(true);
		expect(refused.lines).toEqual([matchingZero, active]);
	});

	it("restores a removed full line once without overwriting an identical replacement", () => {
		const line: CartLine = { ...createCartLine(item, [pepperPacket, sliced]), quantity: 2 };
		const restored = cartReducer([], { type: "restore", line });
		const duplicateRestore = cartReducer(restored, { type: "restore", line });
		expect(restored).toEqual([line]);
		expect(duplicateRestore).toEqual([line]);
	});
});

describe("cart calculations", () => {
	it("adds integer modifier deltas to the base unit price", () => {
		expect(calculateUnitPrice(item.price, [mild, sliced])).toBe(90);
	});

	it("calculates line subtotals and the cart total", () => {
		const first: CartLine = { ...createCartLine(item, [mild, sliced]), quantity: 2 };
		const second: CartLine = {
			...createCartLine({ id: 2, name: "甜不辣", price: 40 }, []),
			quantity: 1,
		};

		expect(getCartLineSubtotal(first)).toBe(180);
		expect(getCartTotal([first, second])).toBe(220);
	});
});

describe("spice defaults and zero-quantity drafts", () => {
	const product: MenuItem = {
		id: 9, name: "薯條", description: "", price: 40, isAvailable: true,
		modifierGroups: [
			{ id: 5, name: "調味", selectionType: "single", isRequired: true, options: [{ id: 16, name: "胡椒", priceDelta: 0 }] },
			{ id: 90, name: "辣度", selectionType: "single", isRequired: false, options: [
				{ id: 901, name: "小辣", priceDelta: 0 }, { id: 900, name: "不辣", priceDelta: 0 },
			] },
		],
	};
	it("selects the real non-spicy option even for legacy optional groups and non-default ordering", () => {
		expect(getDefaultOptionIds(product)).toEqual({ 5: 16, 90: 900 });
		expect(hasValidSpiceSelection(product, [])).toBe(false);
		const group = getSpiceGroup(product)!;
		expect(hasValidSpiceSelection(product, [toSelectedModifier(group, group.options[1]!)])).toBe(true);
		expect(getDefaultOptionIds({ ...product, modifierGroups: [{ ...group, options: [group.options[0]!] }] })).toEqual({});
	});
	it("does not invent spice options for the configured 招牌炸蛋 exception", () => {
		const egg = { ...product, id: 5, name: "招牌炸蛋", modifierGroups: [] };
		expect(getSpiceGroup(egg)).toBeUndefined();
		expect(getDefaultOptionIds(egg)).toEqual({});
		expect(hasValidSpiceSelection(egg, [])).toBe(true);
	});
	it("persists only positive lines, drops legacy zero/negative lines on startup, and fills a missing active spice default", () => {
		const modifiers = product.modifierGroups.map((group) => toSelectedModifier(group, group.options.find((option) => option.id === getDefaultOptionIds(product)[group.id])!));
		const line = { ...createCartLine(product, modifiers), quantity: 0 };
		const categories = [{ id: 1, name: "炸物", items: [product] }];
		expect(JSON.parse(serializeCartDraft([line], 1000)).items).toEqual([]);
		const legacy = JSON.stringify({ version: 1, updatedAt: 1000, items: [
			{ menuItemId: 9, quantity: 0, modifierOptionIds: [16, 900] },
			{ menuItemId: 9, quantity: -1, modifierOptionIds: [16, 900] },
			{ menuItemId: 9, quantity: 1, modifierOptionIds: [16] },
		] });
		expect(restoreCartDraft(legacy, categories, 1000)).toMatchObject({ lines: [{ ...line, quantity: 1 }], skippedCount: 2 });
		expect(cartReducer([line], { type: "increase", lineId: line.id })[0]).toEqual({ ...line, quantity: 1 });
	});
});
