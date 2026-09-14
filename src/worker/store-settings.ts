export type StoreSettingsRow = {
	id: number;
	display_name: string;
	is_accepting_orders: number;
	base_prep_minutes: number;
	normal_order_minutes: number;
	special_extra_minutes: number;
	state_version: number;
};

export const MAX_STORE_STATE_VERSION = Number.MAX_SAFE_INTEGER;

export class StoreSettingsError extends Error {
	constructor() {
		super("Store settings are invalid");
		this.name = "StoreSettingsError";
	}
}

export function assertValidStoreState(
	value: unknown,
): asserts value is { is_accepting_orders: 0 | 1; state_version: number } {
	if (
		typeof value !== "object" ||
		value === null ||
		!("is_accepting_orders" in value) ||
		![0, 1].includes(value.is_accepting_orders as number) ||
		!("state_version" in value) ||
		!Number.isSafeInteger(value.state_version) ||
		(value.state_version as number) < 0
	) {
		throw new StoreSettingsError();
	}
}

export async function getStoreSettings(db: D1Database) {
	const store = await db
		.prepare(
			`SELECT
				id,
				display_name,
				is_accepting_orders,
				base_prep_minutes,
				normal_order_minutes,
				special_extra_minutes,
				state_version
			FROM store_settings
			WHERE id = 1`,
		)
		.first<StoreSettingsRow>();
	if (store) assertValidStoreState(store);
	return store;
}
