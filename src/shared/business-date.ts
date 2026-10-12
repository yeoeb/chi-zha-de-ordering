const STORE_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const MERCHANT_HISTORY_WINDOW_DAYS = 90;

export function getStoreBusinessDate(now = new Date()) {
	if (!Number.isFinite(now.getTime())) throw new RangeError("now must be a valid date");
	return new Date(now.getTime() + STORE_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

export function parseStoreBusinessDate(value: string) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const [year, month, day] = value.split("-").map(Number);
	const utcCalendarDate = new Date(Date.UTC(year!, month! - 1, day!));
	if (
		utcCalendarDate.getUTCFullYear() !== year ||
		utcCalendarDate.getUTCMonth() !== month! - 1 ||
		utcCalendarDate.getUTCDate() !== day
	) return null;
	return utcCalendarDate;
}

export function getStoreBusinessDateRange(value: string) {
	const calendarDate = parseStoreBusinessDate(value);
	if (!calendarDate) return null;
	const startMs = calendarDate.getTime() - STORE_UTC_OFFSET_MS;
	return {
		startInclusive: new Date(startMs).toISOString(),
		endExclusive: new Date(startMs + DAY_MS).toISOString(),
	};
}

export function isStoreBusinessDateInHistoryWindow(
	value: string,
	now = new Date(),
	windowDays = MERCHANT_HISTORY_WINDOW_DAYS,
) {
	const selected = parseStoreBusinessDate(value);
	const today = parseStoreBusinessDate(getStoreBusinessDate(now));
	if (!selected || !today || !Number.isSafeInteger(windowDays) || windowDays < 1) return false;
	const differenceDays = Math.floor((today.getTime() - selected.getTime()) / DAY_MS);
	return differenceDays >= 0 && differenceDays < windowDays;
}

export function listStoreBusinessDates(now = new Date(), count = MERCHANT_HISTORY_WINDOW_DAYS) {
	const today = parseStoreBusinessDate(getStoreBusinessDate(now));
	if (!today || !Number.isSafeInteger(count) || count < 1) return [];
	return Array.from({ length: count }, (_, index) =>
		new Date(today.getTime() - index * DAY_MS).toISOString().slice(0, 10),
	);
}
