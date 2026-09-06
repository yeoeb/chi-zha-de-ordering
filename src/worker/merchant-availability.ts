import { getStoreSettings } from "./store-settings";

type AvailabilityControlErrorCode = "MENU_ITEM_NOT_FOUND" | "STORE_SETTINGS_NOT_FOUND";

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
) {
	if (!Number.isSafeInteger(menuItemId) || menuItemId <= 0) {
		throw new AvailabilityControlError(404, "MENU_ITEM_NOT_FOUND", "Menu item not found");
	}

	const item = await db
		.prepare(
			`UPDATE menu_items
			SET is_available = ?
			WHERE id = ?
			RETURNING id, name, is_available AS isAvailable`,
		)
		.bind(isAvailable ? 1 : 0, menuItemId)
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

export async function setStoreAcceptingOrders(db: D1Database, isAcceptingOrders: boolean) {
	await db
		.prepare("UPDATE store_settings SET is_accepting_orders = ? WHERE id = 1")
		.bind(isAcceptingOrders ? 1 : 0)
		.run();
	const store = await getStoreSettings(db);

	if (!store) {
		throw new AvailabilityControlError(
			404,
			"STORE_SETTINGS_NOT_FOUND",
			"Store settings not found",
		);
	}

	return {
		...store,
		is_accepting_orders: Boolean(store.is_accepting_orders),
	};
}
