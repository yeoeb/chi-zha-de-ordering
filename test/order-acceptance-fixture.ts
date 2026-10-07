import { env } from "cloudflare:workers";
import { beforeEach, afterEach, vi } from "vitest";

export const orderTestSchedule = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [
	String(day), { isOpen: day !== 1, openAt: "17:30", closeAt: "23:15" },
]));

// API tests run at a known open instant. Direct domain tests still inject now.
export function setupOrderAcceptanceTests() {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-06T18:00:00+08:00"));
		await env.DB.prepare("UPDATE store_settings SET weekly_business_hours = ?, last_order_time = '23:15' WHERE id = 1")
			.bind(JSON.stringify(orderTestSchedule)).run();
	});
	afterEach(() => vi.useRealTimers());
}
