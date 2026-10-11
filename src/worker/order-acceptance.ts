import { decodeWeeklyBusinessHours } from "./admin-store";
import { scheduledServiceCycle } from "./store-schedule";
import { getOpeningBusinessDay } from "./business-day";
import type { StoreSettingsRow } from "./store-settings";

export class OrderAcceptanceError extends Error {
	readonly status = 409;
	constructor(readonly code: "BUSINESS_HOURS_CLOSED" | "BUSINESS_SCHEDULE_UNAVAILABLE") {
		super(code === "BUSINESS_HOURS_CLOSED"
			? "Orders are accepted only during configured business hours, before the last-order cutoff"
			: "Configure valid business hours and last-order time before accepting new orders");
		this.name = "OrderAcceptanceError";
	}
}

// Opening-cycle identity is shared with daily sold-out maintenance. The approved
// soft-close cycle can continue after midnight while Store remains accepting.
export function assertOrderAcceptanceWindow(
	store: Pick<StoreSettingsRow, "weekly_business_hours" | "last_order_time">,
	now: Date,
	softClosingAuthorized = false,
) {
	if (!Number.isFinite(now.getTime())) throw new RangeError("now must be a valid date");
	let schedule;
	try {
		schedule = decodeWeeklyBusinessHours(store.weekly_business_hours);
	} catch {
		throw new OrderAcceptanceError("BUSINESS_SCHEDULE_UNAVAILABLE");
	}
	if (!schedule || (store.last_order_time !== null && !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(store.last_order_time))) {
		throw new OrderAcceptanceError("BUSINESS_SCHEDULE_UNAVAILABLE");
	}
	if (softClosingAuthorized && scheduledServiceCycle(store, now)) return;
	const day = getOpeningBusinessDay(now, schedule);
	if (!day) throw new OrderAcceptanceError("BUSINESS_HOURS_CLOSED");
	const hours = schedule[String(new Date(day + "T00:00:00Z").getUTCDay())]!;
	const opening = Date.parse(day + "T" + hours.openAt + ":00+08:00");
	const overnight = hours.closeAt < hours.openAt;
	const nextDayMs = 24 * 60 * 60 * 1000;
	const close = Date.parse(day + "T" + hours.closeAt + ":00+08:00") + (overnight ? nextDayMs : 0);
	const cutoffTime = store.last_order_time ?? hours.closeAt;
	const cutoff = Date.parse(day + "T" + cutoffTime + ":00+08:00")
		+ (overnight && cutoffTime < hours.openAt ? nextDayMs : 0);
	if (now.getTime() < opening || now.getTime() >= Math.min(close, cutoff)) {
		throw new OrderAcceptanceError("BUSINESS_HOURS_CLOSED");
	}
}
