export const SPICE_GROUP_NAME = "辣度";
export const DEFAULT_SPICE_NAME = "不辣";

export function requiresModifierSelection(group: { name: string; isRequired: boolean }) {
	return group.isRequired || group.name === SPICE_GROUP_NAME;
}
