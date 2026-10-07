import type { WeeklyBusinessHours } from "../src/worker/admin-store";

export const dailyTestSchedule: WeeklyBusinessHours = Object.fromEntries(
	Array.from({ length: 7 }, (_, day) => [String(day), { isOpen: true, openAt: "17:30", closeAt: "23:15" }]),
);
