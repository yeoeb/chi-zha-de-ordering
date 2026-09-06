export type SingleChoiceModifierGroup = {
	id: number;
	selectionType: "single";
	isRequired: boolean;
	options: ReadonlyArray<{ id: number }>;
};

export function isModifierSelectionComplete(
	groups: ReadonlyArray<SingleChoiceModifierGroup>,
	selectedOptionIds: Readonly<Record<number, number | undefined>>,
) {
	return groups.every((group) => {
		const selectedOptionId = selectedOptionIds[group.id];

		if (selectedOptionId === undefined) {
			return !group.isRequired;
		}

		return group.options.some((option) => option.id === selectedOptionId);
	});
}
