import { requireOpeningBusinessDay } from "./daily-sold-out";

type AvailabilityControlErrorCode = "MENU_ITEM_NOT_FOUND";

export class AvailabilityControlError extends Error {
	constructor(
		readonly status: 404,
		readonly code: AvailabilityControlErrorCode,
		message: string,
	) {
		super(message);
		this.name = "AvailabilityControlError";
	}
}

type MenuItemAvailabilityRow = {
	id: number;
	name: string;
	isAvailable: number;
};

export async function setMenuItemAvailability(
	db: D1Database,
	menuItemId: number,
	isAvailable: boolean,
	now = new Date(),
) {
	if (!Number.isSafeInteger(menuItemId) || menuItemId <= 0) {
		throw new AvailabilityControlError(404, "MENU_ITEM_NOT_FOUND", "Menu item not found");
	}

	let businessDay: string | null = null;
	if (!isAvailable) {
		const exists = await db.prepare("SELECT id FROM menu_items WHERE id = ? AND is_archived = 0")
			.bind(menuItemId).first();
		if (!exists) throw new AvailabilityControlError(404, "MENU_ITEM_NOT_FOUND", "Menu item not found");
		businessDay = await requireOpeningBusinessDay(db, now);
	}
	const item = await db
		.prepare(
			`UPDATE menu_items
			SET is_available = ?, sold_out_business_date = ?
			WHERE id = ? AND is_archived = 0
			RETURNING id, name, is_available AS isAvailable`,
		)
		.bind(isAvailable ? 1 : 0, businessDay, menuItemId)
		.first<MenuItemAvailabilityRow>();

	if (!item) {
		throw new AvailabilityControlError(404, "MENU_ITEM_NOT_FOUND", "Menu item not found");
	}

	return {
		id: item.id,
		name: item.name,
		isAvailable: Boolean(item.isAvailable),
	};
}
