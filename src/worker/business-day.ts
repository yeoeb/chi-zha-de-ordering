import type { WeeklyBusinessHours } from "./admin-store";

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// A service day starts at its configured opening, not at calendar midnight.
// History/calendar filtering intentionally remains a separate contract.
export function getOpeningBusinessDay(now: Date, schedule: WeeklyBusinessHours | null): string | null {
	if (!Number.isFinite(now.getTime())) throw new RangeError("now must be a valid date");
	if (!schedule) return null;
	const localNow = now.getTime() + TAIPEI_OFFSET_MS;
	const calendar = new Date(localNow);
	const midnight = Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth(), calendar.getUTCDate());
	// Include seven days back: before opening on a once-weekly schedule.
	for (let offset = 0; offset <= 7; offset += 1) {
		const date = new Date(midnight - offset * DAY_MS);
		const hours = schedule[String(date.getUTCDay())];
		if (!hours?.isOpen) continue;
		if (!/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(hours.openAt)) return null;
		const [hour, minute] = hours.openAt.split(":").map(Number);
		const opening = date.getTime() + (hour! * 60 + minute!) * 60_000;
		if (opening <= localNow) return date.toISOString().slice(0, 10);
	}
	return null;
}
