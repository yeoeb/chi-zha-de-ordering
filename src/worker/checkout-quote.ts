export const MAX_QUANTITY_PER_LINE = 99;
const MAX_CART_LINES = 50;
const MAX_MODIFIER_OPTIONS_PER_LINE = 50;

export type CheckoutLineSelection = {
	menuItemId: number;
	quantity: number;
	modifierOptionIds: number[];
};

export type PricedCart = {
	items: Array<{
		menuItemId: number;
		name: string;
		quantity: number;
		unitPrice: number;
		lineTotal: number;
		modifiers: Array<{
			groupId: number;
			groupName: string;
			optionId: number;
			name: string;
			priceDelta: number;
		}>;
	}>;
	total: number;
};

export async function createQuoteFingerprint(pricedCart: PricedCart) {
	const items = pricedCart.items
		.map((item) => {
			const modifiers = [...item.modifiers]
				.sort((left, right) => left.groupId - right.groupId || left.optionId - right.optionId)
				.map((modifier) => ({
					groupId: modifier.groupId,
					groupName: modifier.groupName,
					optionId: modifier.optionId,
					name: modifier.name,
					priceDelta: modifier.priceDelta,
				}));
			return {
				menuItemId: item.menuItemId,
				name: item.name,
				quantity: item.quantity,
				basePrice:
					item.unitPrice - modifiers.reduce((total, modifier) => total + modifier.priceDelta, 0),
				modifiers,
				unitPrice: item.unitPrice,
				lineTotal: item.lineTotal,
			};
		})
		.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
	const canonicalQuote = JSON.stringify({ version: 1, items, total: pricedCart.total });
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalQuote));

	return [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

export type CheckoutQuoteErrorCode =
	| "INVALID_REQUEST"
	| "EMPTY_CART"
	| "TOO_MANY_ITEMS"
	| "INVALID_QUANTITY"
	| "UNKNOWN_ITEM"
	| "INACTIVE_ITEM"
	| "UNAVAILABLE_ITEM"
	| "DUPLICATE_MODIFIER_OPTION"
	| "INVALID_MODIFIER_OPTION"
	| "INACTIVE_MODIFIER_GROUP"
	| "INACTIVE_MODIFIER_OPTION"
	| "MISSING_REQUIRED_MODIFIER"
	| "MULTIPLE_MODIFIER_SELECTIONS";

export type CheckoutLineIssueCode =
	| "UNKNOWN_ITEM"
	| "INACTIVE_ITEM"
	| "UNAVAILABLE_ITEM"
	| "INVALID_MODIFIER_OPTION"
	| "INACTIVE_MODIFIER_GROUP"
	| "INACTIVE_MODIFIER_OPTION"
	| "MISSING_REQUIRED_MODIFIER";

export type CheckoutLineIssue = {
	itemIndex: number;
	menuItemId: number;
	code: CheckoutLineIssueCode;
	modifierOptionId?: number;
};

export class CheckoutQuoteError extends Error {
	constructor(
		readonly status: 400 | 422,
		readonly code: CheckoutQuoteErrorCode,
		message: string,
		readonly lineIssues: CheckoutLineIssue[] = [],
	) {
		super(message);
		this.name = "CheckoutQuoteError";
	}
}

function createLineIssueError(
	itemIndex: number,
	selection: CheckoutLineSelection,
	code: CheckoutLineIssueCode,
	message: string,
	modifierOptionId?: number,
) {
	return new CheckoutQuoteError(422, code, message, [{
		itemIndex,
		menuItemId: selection.menuItemId,
		code,
		...(modifierOptionId === undefined ? {} : { modifierOptionId }),
	}]);
}

type QuoteCatalogRow = {
	itemId: number;
	itemName: string;
	itemPrice: number;
	itemIsAvailable: number;
	itemIsArchived: number;
	categoryIsActive: number;
	modifierGroupId: number | null;
	modifierGroupName: string | null;
	modifierGroupSelectionType: "single" | null;
	modifierGroupIsRequired: number | null;
	modifierGroupIsActive: number | null;
	modifierOptionId: number | null;
	modifierOptionName: string | null;
	modifierOptionPriceDelta: number | null;
	modifierOptionIsActive: number | null;
};

type ModifierGroupState = {
	id: number;
	name: string;
	selectionType: "single";
	isRequired: boolean;
	isActive: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>) {
	return Object.keys(value).every((key) => allowedKeys.has(key));
}

function requirePositiveInteger(value: unknown, field: string) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new CheckoutQuoteError(400, "INVALID_REQUEST", `${field} must be a positive integer`);
	}

	return value;
}

function requireNumber(value: unknown, field: string) {
	if (typeof value !== "number") {
		throw new CheckoutQuoteError(400, "INVALID_REQUEST", `${field} must be a number`);
	}

	return value;
}

export function parseCheckoutQuoteRequest(input: unknown): CheckoutLineSelection[] {
	if (!isRecord(input) || !hasOnlyKeys(input, new Set(["items"])) || !Array.isArray(input.items)) {
		throw new CheckoutQuoteError(400, "INVALID_REQUEST", "Request body must contain only an items array");
	}

	if (input.items.length === 0) {
		throw new CheckoutQuoteError(400, "EMPTY_CART", "Cart must contain at least one item");
	}

	if (input.items.length > MAX_CART_LINES) {
		throw new CheckoutQuoteError(400, "TOO_MANY_ITEMS", "Cart contains too many lines");
	}

	return input.items.map((value, index) => {
		if (
			!isRecord(value) ||
			!hasOnlyKeys(value, new Set(["menuItemId", "quantity", "modifierOptionIds"])) ||
			!Array.isArray(value.modifierOptionIds)
		) {
			throw new CheckoutQuoteError(
				400,
				"INVALID_REQUEST",
				`Item at index ${index} has an invalid shape`,
			);
		}

		if (value.modifierOptionIds.length > MAX_MODIFIER_OPTIONS_PER_LINE) {
			throw new CheckoutQuoteError(
				400,
				"INVALID_REQUEST",
				`Item at index ${index} has too many modifier options`,
			);
		}

		return {
			menuItemId: requirePositiveInteger(value.menuItemId, `items[${index}].menuItemId`),
			quantity: requireNumber(value.quantity, `items[${index}].quantity`),
			modifierOptionIds: value.modifierOptionIds.map((optionId, optionIndex) =>
				requirePositiveInteger(
					optionId,
					`items[${index}].modifierOptionIds[${optionIndex}]`,
				),
			),
		};
	});
}

const catalogQuery = `SELECT
	items.id AS itemId,
	items.name AS itemName,
	items.price AS itemPrice,
	items.is_available AS itemIsAvailable,
	items.is_archived AS itemIsArchived,
	categories.is_active AS categoryIsActive,
	modifier_groups.id AS modifierGroupId,
	modifier_groups.name AS modifierGroupName,
	modifier_groups.selection_type AS modifierGroupSelectionType,
	modifier_groups.is_required AS modifierGroupIsRequired,
	modifier_groups.is_active AS modifierGroupIsActive,
	modifier_options.id AS modifierOptionId,
	modifier_options.name AS modifierOptionName,
	modifier_options.price_delta AS modifierOptionPriceDelta,
	modifier_options.is_active AS modifierOptionIsActive
FROM menu_items AS items
JOIN menu_categories AS categories ON categories.id = items.category_id
LEFT JOIN modifier_groups ON modifier_groups.menu_item_id = items.id
LEFT JOIN modifier_options ON modifier_options.modifier_group_id = modifier_groups.id
WHERE items.id = ?
ORDER BY
	modifier_groups.sort_order ASC,
	modifier_groups.id ASC,
	modifier_options.sort_order ASC,
	modifier_options.id ASC`;

export async function validateAndPriceCart(
	db: D1Database,
	selections: ReadonlyArray<CheckoutLineSelection>,
): Promise<PricedCart> {
	if (selections.length === 0) {
		throw new CheckoutQuoteError(400, "EMPTY_CART", "Cart must contain at least one item");
	}

	if (selections.length > MAX_CART_LINES) {
		throw new CheckoutQuoteError(400, "TOO_MANY_ITEMS", "Cart contains too many lines");
	}

	const query = db.prepare(catalogQuery);
	const catalogResults = await db.batch<QuoteCatalogRow>(
		selections.map((selection) => query.bind(selection.menuItemId)),
	);
	const pricedItems: PricedCart["items"] = [];
	const lineIssues: CheckoutLineIssue[] = [];

	for (const [index, selection] of selections.entries()) {
		try {
		if (
			!Number.isSafeInteger(selection.quantity) ||
			selection.quantity <= 0 ||
			selection.quantity > MAX_QUANTITY_PER_LINE
		) {
			throw new CheckoutQuoteError(
				422,
				"INVALID_QUANTITY",
				`Quantity for item at index ${index} must be between 1 and ${MAX_QUANTITY_PER_LINE}`,
			);
		}

		const rows = catalogResults[index]?.results ?? [];
		const item = rows[0];

		if (!item) {
			throw createLineIssueError(index, selection, "UNKNOWN_ITEM", `Menu item ${selection.menuItemId} does not exist`);
		}

		if (!item.categoryIsActive || item.itemIsArchived) {
			throw createLineIssueError(index, selection, "INACTIVE_ITEM", `Menu item ${selection.menuItemId} is not active`);
		}

		if (!item.itemIsAvailable) {
			throw createLineIssueError(index, selection, "UNAVAILABLE_ITEM", `Menu item ${selection.menuItemId} is unavailable`);
		}

		if (new Set(selection.modifierOptionIds).size !== selection.modifierOptionIds.length) {
			throw new CheckoutQuoteError(
				422,
				"DUPLICATE_MODIFIER_OPTION",
				`Menu item ${selection.menuItemId} contains a duplicate modifier option`,
			);
		}

		const groups = new Map<number, ModifierGroupState>();
		const optionRows = new Map<number, QuoteCatalogRow>();

		for (const row of rows) {
			if (
				row.modifierGroupId !== null &&
				row.modifierGroupName !== null &&
				row.modifierGroupSelectionType !== null &&
				row.modifierGroupIsRequired !== null &&
				row.modifierGroupIsActive !== null &&
				!groups.has(row.modifierGroupId)
			) {
				groups.set(row.modifierGroupId, {
					id: row.modifierGroupId,
					name: row.modifierGroupName,
					selectionType: row.modifierGroupSelectionType,
					isRequired: Boolean(row.modifierGroupIsRequired),
					isActive: Boolean(row.modifierGroupIsActive),
				});
			}

			if (row.modifierOptionId !== null) {
				optionRows.set(row.modifierOptionId, row);
			}
		}

		const selectedOptionIds = new Set(selection.modifierOptionIds);
		const selectionsPerGroup = new Map<number, number>();

		for (const optionId of selection.modifierOptionIds) {
			const option = optionRows.get(optionId);

			if (!option || option.modifierGroupId === null) {
				throw createLineIssueError(
					index,
					selection,
					"INVALID_MODIFIER_OPTION",
					`Modifier option ${optionId} does not belong to menu item ${selection.menuItemId}`,
					optionId,
				);
			}

			const group = groups.get(option.modifierGroupId);

			if (!group?.isActive) {
				throw createLineIssueError(
					index,
					selection,
					"INACTIVE_MODIFIER_GROUP",
					`Modifier option ${optionId} belongs to an inactive group`,
					optionId,
				);
			}

			if (!option.modifierOptionIsActive) {
				throw createLineIssueError(
					index,
					selection,
					"INACTIVE_MODIFIER_OPTION",
					`Modifier option ${optionId} is inactive`,
					optionId,
				);
			}

			selectionsPerGroup.set(group.id, (selectionsPerGroup.get(group.id) ?? 0) + 1);
		}

		for (const group of groups.values()) {
			if (!group.isActive) {
				continue;
			}

			const selectionCount = selectionsPerGroup.get(group.id) ?? 0;

			if (group.selectionType === "single" && selectionCount > 1) {
				throw new CheckoutQuoteError(
					422,
					"MULTIPLE_MODIFIER_SELECTIONS",
					`Modifier group ${group.name} accepts exactly one option`,
				);
			}

			if (group.isRequired && selectionCount !== 1) {
				throw createLineIssueError(
					index,
					selection,
					"MISSING_REQUIRED_MODIFIER",
					`Modifier group ${group.name} requires exactly one option`,
				);
			}
		}

		const modifiers = rows.flatMap((row) => {
			if (
				row.modifierGroupId === null ||
				row.modifierGroupName === null ||
				row.modifierOptionId === null ||
				row.modifierOptionName === null ||
				row.modifierOptionPriceDelta === null ||
				!selectedOptionIds.has(row.modifierOptionId)
			) {
				return [];
			}

			return [
				{
					groupId: row.modifierGroupId,
					groupName: row.modifierGroupName,
					optionId: row.modifierOptionId,
					name: row.modifierOptionName,
					priceDelta: row.modifierOptionPriceDelta,
				},
			];
		});
		const unitPrice = item.itemPrice + modifiers.reduce((sum, modifier) => sum + modifier.priceDelta, 0);
		const lineTotal = unitPrice * selection.quantity;

		if (
			!Number.isSafeInteger(unitPrice) ||
			unitPrice < 0 ||
			!Number.isSafeInteger(lineTotal) ||
			lineTotal < 0
		) {
			throw new Error(`Menu item ${selection.menuItemId} produced an invalid price`);
		}

		pricedItems.push({
			menuItemId: item.itemId,
			name: item.itemName,
			quantity: selection.quantity,
			unitPrice,
			lineTotal,
			modifiers,
		});
		} catch (error) {
			if (error instanceof CheckoutQuoteError && error.lineIssues.length > 0) {
				lineIssues.push(...error.lineIssues);
				continue;
			}
			throw error;
		}
	}

	if (lineIssues.length > 0) {
		throw new CheckoutQuoteError(
			422,
			lineIssues[0]!.code,
			"One or more Cart lines are no longer available",
			lineIssues,
		);
	}

	const total = pricedItems.reduce((sum, item) => sum + item.lineTotal, 0);

	if (!Number.isSafeInteger(total) || total < 0) {
		throw new Error("Cart produced an invalid total");
	}

	return { items: pricedItems, total };
}
