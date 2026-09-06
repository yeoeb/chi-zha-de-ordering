import { describe, expect, it } from "vitest";
import {
	calculateUnitPrice,
	cartReducer,
	createCartLine,
	getCartLineSubtotal,
	getCartTotal,
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

	it("increases, decreases without going negative, and removes explicitly", () => {
		const line = createCartLine(item, [mild, sliced]);
		const one = cartReducer([], { type: "add", line });
		const two = cartReducer(one, { type: "increase", lineId: line.id });
		const backToOne = cartReducer(two, { type: "decrease", lineId: line.id });
		const stillOne = cartReducer(backToOne, { type: "decrease", lineId: line.id });
		const removed = cartReducer(stillOne, { type: "remove", lineId: line.id });

		expect(two[0]?.quantity).toBe(2);
		expect(backToOne[0]?.quantity).toBe(1);
		expect(stillOne[0]?.quantity).toBe(1);
		expect(removed).toEqual([]);
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
