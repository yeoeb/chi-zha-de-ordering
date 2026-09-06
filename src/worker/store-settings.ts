export type StoreSettingsRow = {
	id: number;
	display_name: string;
	is_accepting_orders: number;
	base_prep_minutes: number;
	normal_order_minutes: number;
	special_extra_minutes: number;
};

export async function getStoreSettings(db: D1Database) {
	return db
		.prepare(
			`SELECT
				id,
				display_name,
				is_accepting_orders,
				base_prep_minutes,
				normal_order_minutes,
				special_extra_minutes
			FROM store_settings
			WHERE id = 1`,
		)
		.first<StoreSettingsRow>();
}
