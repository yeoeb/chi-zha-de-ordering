import type { SelectedModifier } from "./cart";

export type ModifierOption = {
	id: number;
	name: string;
	priceDelta: number;
};

export type ModifierGroup = {
	id: number;
	name: string;
	selectionType: "single";
	isRequired: boolean;
	options: ModifierOption[];
};

export type MenuItem = {
	id: number;
	name: string;
	description: string;
	price: number;
	isAvailable: boolean;
	modifierGroups: ModifierGroup[];
	imageUrl?: string | null;
	isPopular?: boolean;
	isQuickSoldOut?: boolean;
};

export type MenuCategory = {
	id: number;
	name: string;
	items: MenuItem[];
};

export type MainOptionDefinition = {
	id: string;
	label: string;
	group: ModifierGroup;
};

export type SpecialOptionChoice = {
	id: string;
	label: string;
	group: ModifierGroup;
	option: ModifierOption;
};

type ProductModifierPresentation = {
	defaultOptionIds: Record<number, number>;
	mainGroupIds: number[];
	spiceGroupId?: number;
};

// Stable IDs from the human-approved 43-item production menu configuration.
const productModifierPresentation: Record<number, ProductModifierPresentation> = {
	1: { defaultOptionIds: { 1: 1, 2: 5 }, mainGroupIds: [2], spiceGroupId: 1 },
	3: { defaultOptionIds: { 8: 29 }, mainGroupIds: [8] },
	4: { defaultOptionIds: { 3: 7, 7: 27 }, mainGroupIds: [7], spiceGroupId: 3 },
	6: { defaultOptionIds: { 4: 11 }, mainGroupIds: [], spiceGroupId: 4 },
	9: { defaultOptionIds: { 5: 16 }, mainGroupIds: [5] },
	10: { defaultOptionIds: { 6: 18 }, mainGroupIds: [6] },
};

export const spiceChoices = ["不辣", "微辣", "小辣", "中辣", "大辣", "辣粉另包"] as const;
export type SpiceChoice = (typeof spiceChoices)[number];

const mainOptionGroupNames = new Set(["份量", "調味", "調味料", "切法"]);
const seasoningOffLabels = new Set(["不加調味", "原味"]);

export function isPopularItem(item: MenuItem) {
	return Boolean(item.isPopular);
}

export function getSpiceGroup(item: MenuItem) {
	const configuredId = productModifierPresentation[item.id]?.spiceGroupId;
	return item.modifierGroups.find(
		(group) => group.id === configuredId || (configuredId === undefined && group.name === "辣度"),
	);
}

export function getMainOptionDefinitions(item: MenuItem): MainOptionDefinition[] {
	const configuredIds = productModifierPresentation[item.id]?.mainGroupIds;
	return item.modifierGroups
		.filter((group) => {
			if (group.id === getSpiceGroup(item)?.id) return false;
			return configuredIds
				? configuredIds.includes(group.id)
				: mainOptionGroupNames.has(group.name);
		})
		.map((group) => ({ id: `group-${group.id}`, label: group.name, group }));
}

export function getSpecialOptionChoices(item: MenuItem): SpecialOptionChoice[] {
	const mainDefinitions = getMainOptionDefinitions(item);
	const mainGroupIds = new Set(mainDefinitions.map((definition) => definition.group.id));
	const hasSeasoningOffChoice = mainDefinitions.some((definition) =>
		definition.group.options.some((option) => option.name === "不加調味"),
	);

	return item.modifierGroups.flatMap((group) => {
		if (
			group.isRequired ||
			group.id === getSpiceGroup(item)?.id ||
			mainGroupIds.has(group.id) ||
			!group.name.startsWith("特殊選項：") ||
			group.options.length !== 1
		) {
			return [];
		}

		const option = group.options[0];
		if (!option || option.priceDelta !== 0) return [];
		if (hasSeasoningOffChoice && seasoningOffLabels.has(option.name)) return [];

		return [{
			id: `special-${group.id}-${option.id}`,
			label: group.name.slice("特殊選項：".length).trim() || option.name,
			group,
			option,
		}];
	});
}

export function getDefaultOptionIds(item: MenuItem) {
	const selected: Record<number, number> = {};
	const configuredDefaults = productModifierPresentation[item.id]?.defaultOptionIds ?? {};

	for (const group of item.modifierGroups) {
		if (!group.isRequired) continue;
		const configuredOption = group.options.find(
			(option) => option.id === configuredDefaults[group.id],
		);
		const selectedOption = configuredOption ?? group.options[0];
		if (selectedOption) selected[group.id] = selectedOption.id;
	}

	return selected;
}

export function toSelectedModifier(
	group: ModifierGroup,
	option: ModifierOption,
): SelectedModifier {
	return {
		groupId: group.id,
		groupName: group.name,
		optionId: option.id,
		optionName: option.name,
		priceDelta: option.priceDelta,
	};
}
