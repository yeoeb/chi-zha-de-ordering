import { createCartLine, type CartLine } from "./cart";
import { getDefaultOptionIds, getSpiceGroup, toSelectedModifier, type MenuCategory, type MenuItem } from "./customer-menu";
import { requiresModifierSelection } from "../shared/spice";

export const CART_DRAFT_STORAGE_KEY = "chi-zha-de:cart-draft";
export const CART_DRAFT_VERSION = 1;
export const CART_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QUANTITY_PER_LINE = 99;
const MAX_CART_LINES = 50;

type StoredCartLine = {
	menuItemId: number;
	quantity: number;
	modifierOptionIds: number[];
};

type StoredCartDraft = {
	version: typeof CART_DRAFT_VERSION;
	updatedAt: number;
	items: StoredCartLine[];
};

export type CartDraftRestoreResult = {
	lines: CartLine[];
	status: "empty" | "expired" | "invalid" | "restored";
	skippedCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function rebuildLine(item: MenuItem, stored: StoredCartLine): CartLine | null {
	if (!item.isAvailable) return null;
	if (!Number.isSafeInteger(stored.quantity) || stored.quantity <= 0 || stored.quantity > MAX_QUANTITY_PER_LINE) {
		return null;
	}
	if (
		!Array.isArray(stored.modifierOptionIds) ||
		stored.modifierOptionIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
		new Set(stored.modifierOptionIds).size !== stored.modifierOptionIds.length
	) {
		return null;
	}

	const optionIds = [...stored.modifierOptionIds];
	const spiceGroup = getSpiceGroup(item);
	if (spiceGroup && !spiceGroup.options.some((option) => optionIds.includes(option.id))) {
		const defaultId = getDefaultOptionIds(item)[spiceGroup.id];
		if (defaultId !== undefined) optionIds.push(defaultId);
	}
	const selectedModifiers = item.modifierGroups.flatMap((group) => {
		const selectedOptions = group.options.filter((option) => optionIds.includes(option.id));
		if (selectedOptions.length > 1 || (requiresModifierSelection(group) && selectedOptions.length !== 1)) return [];
		return selectedOptions.map((option) => toSelectedModifier(group, option));
	});
	const knownOptionIds = new Set(item.modifierGroups.flatMap((group) => group.options.map((option) => option.id)));
	if (stored.modifierOptionIds.some((id) => !knownOptionIds.has(id))) return null;
	if (selectedModifiers.length !== optionIds.length) return null;
	if (
		item.modifierGroups.some(
			(group) => requiresModifierSelection(group) && !selectedModifiers.some((modifier) => modifier.groupId === group.id),
		)
	) {
		return null;
	}

	return { ...createCartLine(item, selectedModifiers), quantity: stored.quantity };
}

export function serializeCartDraft(cart: CartLine[], now = Date.now()): string {
	const draft: StoredCartDraft = {
		version: CART_DRAFT_VERSION,
		updatedAt: now,
		items: cart.filter((line) => line.quantity > 0).map((line) => ({
			menuItemId: line.menuItemId,
			quantity: line.quantity,
			modifierOptionIds: line.selectedModifiers.map((modifier) => modifier.optionId),
		})),
	};
	return JSON.stringify(draft);
}

export function restoreCartDraft(
	raw: string | null,
	categories: MenuCategory[],
	now = Date.now(),
): CartDraftRestoreResult {
	if (!raw) return { lines: [], status: "empty", skippedCount: 0 };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { lines: [], status: "invalid", skippedCount: 0 };
	}

	if (
		!isRecord(parsed) ||
		!hasOnlyKeys(parsed, ["version", "updatedAt", "items"]) ||
		parsed.version !== CART_DRAFT_VERSION ||
		typeof parsed.updatedAt !== "number" ||
		!Number.isFinite(parsed.updatedAt) ||
		!Array.isArray(parsed.items) ||
		parsed.items.length > MAX_CART_LINES
	) {
		return { lines: [], status: "invalid", skippedCount: 0 };
	}
	if (parsed.updatedAt > now + 60_000 || now - parsed.updatedAt > CART_DRAFT_TTL_MS) {
		return { lines: [], status: "expired", skippedCount: parsed.items.length };
	}

	const itemsById = new Map(categories.flatMap((category) => category.items).map((item) => [item.id, item]));
	const lines: CartLine[] = [];
	let skippedCount = 0;
	for (const value of parsed.items) {
		if (
			!isRecord(value) ||
			!hasOnlyKeys(value, ["menuItemId", "quantity", "modifierOptionIds"]) ||
			!Number.isSafeInteger(value.menuItemId) ||
			!Number.isSafeInteger(value.quantity) ||
			!Array.isArray(value.modifierOptionIds)
		) {
			skippedCount += 1;
			continue;
		}
		const stored = value as StoredCartLine;
		const item = itemsById.get(stored.menuItemId);
		const line = item ? rebuildLine(item, stored) : null;
		if (!line || lines.some((candidate) => candidate.id === line.id)) {
			skippedCount += 1;
			continue;
		}
		lines.push(line);
	}

	return { lines, status: "restored", skippedCount };
}

export function revalidateCartLine(line: CartLine, categories: MenuCategory[]) {
	const item = categories.flatMap((category) => category.items).find((candidate) => candidate.id === line.menuItemId);
	if (!item) return null;
	return rebuildLine(item, {
		menuItemId: line.menuItemId,
		quantity: line.quantity,
		modifierOptionIds: line.selectedModifiers.map((modifier) => modifier.optionId),
	});
}
