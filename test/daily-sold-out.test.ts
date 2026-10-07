import { setupOrderAcceptanceTests } from "./order-acceptance-fixture";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker/index";
import { getOpeningBusinessDay } from "../src/worker/business-day";
import { restorePreviousBusinessDaySoldOut } from "../src/worker/daily-sold-out";
import { setMenuItemAvailability } from "../src/worker/merchant-availability";
import { dailyTestSchedule } from "./business-hours-fixture";

const opening = new Date("2026-10-06T09:30:00Z");
const schedule = { ...dailyTestSchedule, "3": { ...dailyTestSchedule["3"]!, isOpen: false } };

describe("opening-cycle Business Day (Asia/Taipei)", () => {
	it.each([
		["2026-10-06T19:30:00+08:00", "2026-10-06"],
		["2026-10-06T17:30:00+08:00", "2026-10-06"],
		["2026-10-06T17:29:59+08:00", "2026-10-05"],
		["2026-10-06T03:00:00+08:00", "2026-10-05"],
		["2026-10-06T10:00:00+08:00", "2026-10-05"],
		["2026-10-06T23:59:59+08:00", "2026-10-06"],
		["2026-10-07T00:00:00+08:00", "2026-10-06"],
		["2026-10-07T00:30:00+08:00", "2026-10-06"],
		["2026-10-07T19:00:00+08:00", "2026-10-06"],
		["2026-10-08T17:29:59+08:00", "2026-10-06"],
		["2026-10-08T17:30:00+08:00", "2026-10-08"],
	])("%s belongs to %s", (instant, expected) => {
		expect(getOpeningBusinessDay(new Date(instant), schedule)).toBe(expected);
	});
	it("uses configured openings, including cross-midnight close and once-weekly opening", () => {
		const weekly = Object.fromEntries(Object.entries(schedule).map(([day, hours]) => [day,
			{ ...hours, isOpen: day === "2", openAt: "21:15", closeAt: "02:00" },
		]));
		expect(getOpeningBusinessDay(new Date("2026-10-13T21:14:59+08:00"), weekly)).toBe("2026-10-06");
		expect(getOpeningBusinessDay(new Date("2026-10-13T21:15:00+08:00"), weekly)).toBe("2026-10-13");
	});
	it("does not invent a day for missing or all-closed schedules", () => {
		expect(getOpeningBusinessDay(opening, null)).toBeNull();
		expect(getOpeningBusinessDay(opening, Object.fromEntries(Object.entries(schedule).map(([day, hours]) => [day, { ...hours, isOpen: false }])))).toBeNull();
		expect(() => getOpeningBusinessDay(new Date("invalid"), schedule)).toThrow(RangeError);
	});
});

setupOrderAcceptanceTests();

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare("INSERT INTO menu_categories (id,name,sort_order,is_active) VALUES (970,'營業日測試',970,1)"),
		env.DB.prepare(`INSERT INTO menu_items (id,category_id,name,description,price,sort_order,is_available)
			VALUES (970,970,'昨日售罄','',50,1,1),(971,970,'今日售罄','',60,2,1),
			(972,970,'舊停售','',70,3,1),(973,970,'封存','',80,4,1),
			(974,970,'可售','',90,5,1),(975,970,'新營業日','',100,6,1)`),
	]);
});

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM order_auto_rejection_events WHERE order_id IN ('daily-due','daily-fail')"),
		env.DB.prepare("DELETE FROM orders WHERE id IN ('daily-due','daily-fail')"),
		env.DB.prepare("UPDATE store_settings SET weekly_business_hours = ?, is_accepting_orders=1, state_version=3, missed_order_count=0 WHERE id=1").bind(JSON.stringify(schedule)),
		env.DB.prepare("UPDATE menu_items SET is_available=1, is_archived=0, sold_out_business_date=NULL WHERE category_id=970"),
		env.DB.prepare("UPDATE menu_items SET is_available=0, sold_out_business_date='2026-10-05' WHERE id IN (970,973)"),
		env.DB.prepare("UPDATE menu_items SET is_available=0, sold_out_business_date='2026-10-06' WHERE id=971"),
		env.DB.prepare("UPDATE menu_items SET is_available=0 WHERE id=972"),
		env.DB.prepare("UPDATE menu_items SET is_archived=1 WHERE id=973"),
		env.DB.prepare("UPDATE menu_items SET is_available=0, sold_out_business_date='2026-10-08' WHERE id=975"),
	]);
});
afterEach(() => vi.useRealTimers());

async function state(id = 970) {
	return env.DB.prepare("SELECT is_available AS available, sold_out_business_date AS day FROM menu_items WHERE id=?").bind(id).first();
}

describe("D1 daily sold-out maintenance", () => {
	it("restores only older non-archived daily sold-out; NULL/current/future/available are untouched and repeat is no-op", async () => {
		expect(await restorePreviousBusinessDaySoldOut(env.DB, opening)).toMatchObject({ restoredCount: 1, businessDay: "2026-10-06" });
		expect(await state()).toEqual({ available: 1, day: null });
		expect(await state(971)).toEqual({ available: 0, day: "2026-10-06" });
		expect(await state(972)).toEqual({ available: 0, day: null });
		expect(await state(973)).toEqual({ available: 0, day: "2026-10-05" });
		expect(await state(974)).toEqual({ available: 1, day: null });
		expect(await state(975)).toEqual({ available: 0, day: "2026-10-08" });
		expect(await restorePreviousBusinessDaySoldOut(env.DB, opening)).toMatchObject({ restoredCount: 0 });
	});
	it("midnight, before-opening and closed-day ticks cannot restore that service day's sold-out", async () => {
		for (const instant of ["2026-10-07T00:00:00+08:00", "2026-10-07T19:00:00+08:00", "2026-10-08T17:29:59+08:00"]) {
			await restorePreviousBusinessDaySoldOut(env.DB, new Date(instant));
			expect(await state(971)).toEqual({ available: 0, day: "2026-10-06" });
		}
		await restorePreviousBusinessDaySoldOut(env.DB, new Date("2026-10-08T17:30:00+08:00"));
		expect(await state(971)).toEqual({ available: 1, day: null });
	});
	it.each(["reset-first", "merchant-first", "concurrent"])("protects current-day sold-out: %s", async (order) => {
		if (order === "reset-first") {
			await restorePreviousBusinessDaySoldOut(env.DB, opening);
			await setMenuItemAvailability(env.DB, 970, false, opening);
		} else if (order === "merchant-first") {
			await setMenuItemAvailability(env.DB, 970, false, opening);
			await restorePreviousBusinessDaySoldOut(env.DB, opening);
		} else {
			await Promise.all([restorePreviousBusinessDaySoldOut(env.DB, opening), setMenuItemAvailability(env.DB, 970, false, opening)]);
		}
		expect(await state()).toEqual({ available: 0, day: "2026-10-06" });
	});
	it("a delayed old-day tick cannot undo newer Merchant sold-out", async () => {
		await setMenuItemAvailability(env.DB, 970, false, new Date("2026-10-08T17:30:00+08:00"));
		await restorePreviousBusinessDaySoldOut(env.DB, opening);
		expect(await state()).toEqual({ available: 0, day: "2026-10-08" });
	});
	it("manual restore clears marker atomically, including with no schedule", async () => {
		await env.DB.prepare("UPDATE store_settings SET weekly_business_hours=NULL WHERE id=1").run();
		await setMenuItemAvailability(env.DB, 970, true, opening);
		expect(await state()).toEqual({ available: 1, day: null });
		expect(await restorePreviousBusinessDaySoldOut(env.DB, opening)).toMatchObject({ skipped: true, restoredCount: 0 });
	});
	it.each([null, "{}"])("missing/invalid schedule rejects Merchant sold-out without mutation (%s)", async (value) => {
		await env.DB.prepare("UPDATE store_settings SET weekly_business_hours=? WHERE id=1").bind(value).run();
		const before = await state();
		const response = await exports.default.fetch("https://example.com/api/merchant/menu-items/970/sold-out", {
			method: "POST", headers: { Origin: "https://example.com", "Sec-Fetch-Site": "same-origin" },
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: { code: "BUSINESS_SCHEDULE_UNAVAILABLE" } });
		expect(await state()).toEqual(before);
		expect(await restorePreviousBusinessDaySoldOut(env.DB, opening)).toMatchObject({ skipped: true });
	});
	it("Menu/Quote reflect the same restored availability without a client reset", async () => {
		const request = { items: [{ menuItemId: 970, quantity: 1, modifierOptionIds: [] }] };
		const quote = () => exports.default.fetch("https://example.com/api/checkout/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
		expect((await quote()).status).toBe(422);
		await restorePreviousBusinessDaySoldOut(env.DB, opening);
		expect((await quote()).status).toBe(200);
		const menu = await (await exports.default.fetch("https://example.com/api/menu")).json() as { categories: Array<{ items: Array<{ id: number; isAvailable: boolean }> }> };
		expect(menu.categories.flatMap((category) => category.items).find((item) => item.id === 970)?.isAvailable).toBe(true);
	});
	it("Merchant marker is backend-derived, ignoring client businessDate", async () => {
		vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(opening);
		const response = await exports.default.fetch("https://example.com/api/merchant/menu-items/970/sold-out", {
			method: "POST", headers: { Origin: "https://example.com", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
			body: JSON.stringify({ businessDate: "2000-01-01" }),
		});
		expect(response.status).toBe(200);
		expect(await state()).toEqual({ available: 0, day: "2026-10-06" });
	});
	it("restored product can create a normally validated Order at authoritative price", async () => {
		await restorePreviousBusinessDaySoldOut(env.DB, opening);
		const items = [{ menuItemId: 970, quantity: 2, modifierOptionIds: [] }];
		const quote = await (await exports.default.fetch("https://example.com/api/checkout/quote", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }),
		})).json() as { quoteFingerprint: string };
		const response = await exports.default.fetch("https://example.com/api/orders", {
			method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "daily-restored-order" },
			body: JSON.stringify({ customerName: "測試", customerPhone: "0912345678", items, quoteFingerprint: quote.quoteFingerprint }),
		});
		expect(response.status).toBe(201);
		expect(await env.DB.prepare("SELECT total_amount AS total FROM orders WHERE idempotency_key='daily-restored-order'").first()).toEqual({ total: 100 });
	});
});

async function runTick() {
	const tasks: Promise<unknown>[] = [];
	worker.scheduled({} as ScheduledController, env, { waitUntil: (task: Promise<unknown>) => tasks.push(task) } as unknown as ExecutionContext);
	return Promise.allSettled(tasks);
}

describe("actual scheduled entrypoint", () => {
	it("runs sold-out maintenance and keeps Store/menu prices/history unchanged", async () => {
		vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(opening);
		const baseline = await env.DB.prepare("SELECT state_version,is_accepting_orders,(SELECT COUNT(*) FROM orders) AS orders,(SELECT SUM(price) FROM menu_items) AS prices FROM store_settings WHERE id=1").first();
		expect((await runTick()).map((task) => task.status)).toEqual(["fulfilled", "fulfilled"]);
		expect(await state()).toEqual({ available: 1, day: null });
		expect(await env.DB.prepare("SELECT state_version,is_accepting_orders,(SELECT COUNT(*) FROM orders) AS orders,(SELECT SUM(price) FROM menu_items) AS prices FROM store_settings WHERE id=1").first()).toEqual(baseline);
	});
	it("sold-out SQL failure does not block the existing auto-rejection", async () => {
		vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(opening);
		await env.DB.prepare(`INSERT INTO orders (id,order_number,status,total_amount,estimated_ready_at,created_at,customer_name,customer_phone,special_order,idempotency_key,request_fingerprint,public_lookup_token)
			VALUES ('daily-due','DAILY-DUE','pending',0,'2026-10-06T09:40:00Z','2026-10-06T09:00:00Z','測試','0912345678',0,'daily-due',?,?)`).bind("a".repeat(64), "b".repeat(64)).run();
		await env.DB.exec("CREATE TRIGGER fail_daily_reset BEFORE UPDATE OF is_available ON menu_items WHEN OLD.id=970 BEGIN SELECT RAISE(ABORT,'reset probe'); END;");
		try {
			expect((await runTick()).map((task) => task.status)).toEqual(["fulfilled", "rejected"]);
			expect(await env.DB.prepare("SELECT status,rejection_reason FROM orders WHERE id='daily-due'").first()).toEqual({ status: "rejected", rejection_reason: "auto_rejected_unanswered" });
			expect(await state()).toEqual({ available: 0, day: "2026-10-05" });
		} finally { await env.DB.exec("DROP TRIGGER fail_daily_reset;"); }
	});
	it("auto-rejection failure does not block sold-out maintenance", async () => {
		vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(opening);
		await env.DB.prepare(`INSERT INTO orders (id,order_number,status,total_amount,estimated_ready_at,created_at,customer_name,customer_phone,special_order,idempotency_key,request_fingerprint,public_lookup_token)
			VALUES ('daily-fail','DAILY-FAIL','pending',0,'2026-10-06T09:40:00Z','2026-10-06T09:00:00Z','測試','0912345678',0,'daily-fail',?,?)`).bind("a".repeat(64), "c".repeat(64)).run();
		await env.DB.exec("CREATE TRIGGER fail_daily_reject BEFORE UPDATE ON orders BEGIN SELECT RAISE(ABORT,'reject probe'); END;");
		try {
			expect((await runTick()).map((task) => task.status)).toEqual(["rejected", "fulfilled"]);
			expect(await state()).toEqual({ available: 1, day: null });
		} finally { await env.DB.exec("DROP TRIGGER fail_daily_reject;"); }
	});
});
