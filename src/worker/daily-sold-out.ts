import { decodeWeeklyBusinessHours } from "./admin-store";
import { getOpeningBusinessDay } from "./business-day";

export class BusinessScheduleUnavailableError extends Error {
	readonly status = 409;
	readonly code = "BUSINESS_SCHEDULE_UNAVAILABLE";
	constructor() {
		super("Configure valid weekly business hours before marking daily sold-out items");
		this.name = "BusinessScheduleUnavailableError";
	}
}

export async function readOpeningBusinessDay(db: D1Database, now: Date) {
	const row = await db.prepare("SELECT weekly_business_hours AS schedule FROM store_settings WHERE id = 1")
		.first<{ schedule: string | null }>();
	if (!row) return null;
	try {
		return getOpeningBusinessDay(now, decodeWeeklyBusinessHours(row.schedule));
	} catch {
		// Missing/corrupt/all-closed configuration must never revive inventory.
		return null;
	}
}

export async function requireOpeningBusinessDay(db: D1Database, now: Date) {
	const day = await readOpeningBusinessDay(db, now);
	if (!day) throw new BusinessScheduleUnavailableError();
	return day;
}

export async function restorePreviousBusinessDaySoldOut(db: D1Database, now = new Date()) {
	const businessDay = await readOpeningBusinessDay(db, now);
	if (!businessDay) return { businessDay: null, restoredCount: 0, skipped: true };
	// Strictly older, never merely different: a delayed tick cannot clear a
	// newer day's Merchant write. The predicate is evaluated inside this write.
	const result = await db.prepare(
		`UPDATE menu_items SET is_available = 1, sold_out_business_date = NULL
		WHERE is_available = 0 AND is_archived = 0
			AND sold_out_business_date IS NOT NULL AND sold_out_business_date < ?`,
	).bind(businessDay).run();
	return { businessDay, restoredCount: result.meta.changes, skipped: false };
}
