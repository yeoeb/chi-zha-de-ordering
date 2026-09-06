import { describe, expect, it } from "vitest";
import { isModifierSelectionComplete } from "../src/react-app/modifier-selection";

const groups = [
	{
		id: 10,
		selectionType: "single" as const,
		isRequired: true,
		options: [{ id: 100 }, { id: 101 }],
	},
	{
		id: 20,
		selectionType: "single" as const,
		isRequired: true,
		options: [{ id: 200 }, { id: 201 }],
	},
];

describe("single-choice modifier validation", () => {
	it("requires one valid option from every required group", () => {
		expect(isModifierSelectionComplete(groups, {})).toBe(false);
		expect(isModifierSelectionComplete(groups, { 10: 100 })).toBe(false);
		expect(isModifierSelectionComplete(groups, { 10: 100, 20: 200 })).toBe(true);
		expect(isModifierSelectionComplete(groups, { 10: 999, 20: 200 })).toBe(false);
	});
});
