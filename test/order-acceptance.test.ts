import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { orderTestSchedule, setupOrderAcceptanceTests } from "./order-acceptance-fixture";
import { getOpeningBusinessDay } from "../src/worker/business-day";
import { createQuoteFingerprint, validateAndPriceCart } from "../src/worker/checkout-quote";
import { createOrder } from "../src/worker/order-creation";
import { listActiveMerchantOrders, transitionMerchantOrder } from "../src/worker/merchant-orders";
import { enableTestScheduler } from "./scheduler-activation-fixture";

setupOrderAcceptanceTests();
const items = [{ menuItemId: 990, quantity: 1, modifierOptionIds: [] }];
const sources = ["online", "onsite"] as const;
const boundaries = [
	["2026-10-06T17:29:59+08:00", false],
	["2026-10-06T17:30:00+08:00", true],
	["2026-10-06T23:14:59+08:00", true],
	["2026-10-06T23:15:00+08:00", true],
	["2026-10-07T00:30:00+08:00", true],
	["2026-10-12T18:00:00+08:00", false],
] as const;

beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare("INSERT INTO menu_categories (id,name,sort_order,is_active) VALUES (990,'時段測試',990,1)"),
		env.DB.prepare("INSERT INTO menu_items (id,category_id,name,description,price,sort_order,is_available) VALUES (990,990,'測試餐點','',60,990,1)"),
	]);
});
beforeEach(async () => {
	await enableTestScheduler((env as typeof env & { CF_VERSION_METADATA: { id:string } }).CF_VERSION_METADATA.id);
	await env.DB.batch([
		env.DB.prepare("DELETE FROM web_push_notification_deliveries"),
		env.DB.prepare("DELETE FROM order_item_modifiers"),
		env.DB.prepare("DELETE FROM order_items"),
		env.DB.prepare("DELETE FROM orders"),
		env.DB.prepare("UPDATE store_settings SET is_accepting_orders=1,state_version=11,missed_order_count=0,auto_pause_reason=NULL WHERE id=1"),
	]);
});
async function fingerprint() { return createQuoteFingerprint(await validateAndPriceCart(env.DB, items)); }
async function post(source: typeof sources[number], key: string, quoteFingerprint?: string) {
	quoteFingerprint ??= await fingerprint();
	return exports.default.fetch("https://example.com" + (source === "online" ? "/api/orders" : "/api/onsite/orders"), {
		method: "POST", headers: { "Content-Type": "application/json", Origin: "https://example.com", "Sec-Fetch-Site": "same-origin", "Idempotency-Key": key },
		body: JSON.stringify({ items, specialOrder: false, quoteFingerprint, ...(source === "online" ? { shortagePolicy: "continue_available" } : {}) }),
	});
}
async function state() {
	return env.DB.prepare(
		"SELECT is_accepting_orders,state_version,missed_order_count,auto_pause_reason,(SELECT COUNT(*) FROM orders) AS orders,(SELECT COUNT(*) FROM order_items) AS items,(SELECT COUNT(*) FROM web_push_notification_deliveries) AS push,(SELECT COUNT(*) FROM order_auto_rejection_events) AS missed_events FROM store_settings WHERE id=1",
	).first();
}
function quote() {
	return exports.default.fetch("https://example.com/api/checkout/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
}

describe("authoritative new-order acceptance window", () => {
	for (const source of sources) {
		it.each(boundaries)(source + " boundary %s accepts=%s", async (instant, open) => {
			vi.setSystemTime(new Date(instant));
			const before = await state();
			const response = await post(source, source + instant);
			expect(response.status).toBe(open ? 201 : 409);
			if (!open) {
				expect(await response.json()).toMatchObject({ error: { code: "BUSINESS_HOURS_CLOSED" } });
				expect(await state()).toEqual(before);
			} else {
				expect(await response.json()).toMatchObject({ order: { orderSource: source, status: "pending", total: 60 } });
				expect(await state()).toMatchObject({ is_accepting_orders: 1, state_version: 11, missed_order_count: 0, orders: 1, items: 1, push: 1, missed_events: 0 });
			}
		});
		it(source + " respects a paused Store within Wednesday opening hours", async () => {
			vi.setSystemTime(new Date("2026-10-07T18:00:00+08:00"));
			await env.DB.prepare("UPDATE store_settings SET is_accepting_orders=0 WHERE id=1").run();
			const before = await state();
			const response = await post(source, "paused-" + source);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ error: { code: "STORE_NOT_ACCEPTING_ORDERS" } });
			expect(await state()).toEqual(before);
		});
		it(source + " accepts a valid earlier quote during soft closing", async () => {
			const confirmed = await (await quote()).json() as { quoteFingerprint: string };
			vi.setSystemTime(new Date("2026-10-06T23:15:00+08:00"));
			const response = await post(source, "stale-quote-" + source, confirmed.quoteFingerprint);
			expect(response.status).toBe(201);
		});
		it(source + " rejects changed contents under an existing key, including after cutoff", async () => {
			const quoteFingerprint=await fingerprint();
			expect((await post(source,"different-body-"+source,quoteFingerprint)).status).toBe(201);
			const before=await state();
			vi.setSystemTime(new Date("2026-10-06T23:15:00+08:00"));
			const response=await exports.default.fetch("https://example.com"+(source==="online"?"/api/orders":"/api/onsite/orders"),{
				method:"POST",headers:{"Content-Type":"application/json",Origin: "https://example.com", "Sec-Fetch-Site": "same-origin", "Idempotency-Key":"different-body-"+source},
				body:JSON.stringify({items:[{...items[0],quantity:2}],specialOrder:false,quoteFingerprint}),
			});
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({error:{code:"IDEMPOTENCY_KEY_CONFLICT"}});
			expect(await state()).toEqual(before);
		});
		it(source + " replays an existing order after cutoff without a second write", async () => {
			const confirmed = await fingerprint();
			expect((await post(source, "replay-" + source, confirmed)).status).toBe(201);
			const before = await state();
			vi.setSystemTime(new Date("2026-10-06T23:15:00+08:00"));
			expect((await post(source, "replay-" + source, confirmed)).status).toBe(200);
			expect(await state()).toEqual(before);
		});
	}
	it.each(boundaries)("Quote boundary %s accepts=%s", async (instant, open) => {
		vi.setSystemTime(new Date(instant));
		const before = await state();
		const response = await quote();
		expect(response.status).toBe(open ? 200 : 409);
		if (!open) expect(await response.json()).toMatchObject({ error: { code: "BUSINESS_HOURS_CLOSED" } });
		expect(await state()).toEqual(before);
	});
	it("keeps Tuesday business-day identity during the Wednesday 00:30 soft extension", () => {
		expect(getOpeningBusinessDay(new Date("2026-10-07T00:30:00+08:00"), orderTestSchedule)).toBe("2026-10-06");
	});
	it.each([null, "{}", "[]"])("fails closed on missing or malformed schedule %s without side effects", async (schedule) => {
		await env.DB.prepare("UPDATE store_settings SET weekly_business_hours=? WHERE id=1").bind(schedule).run();
		const before = await state();
		for (const source of sources) {
			const response = await post(source, "missing-" + source);
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ error: { code: "BUSINESS_SCHEDULE_UNAVAILABLE" } });
		}
		expect((await quote()).status).toBe(409);
		expect(await state()).toEqual(before);
	});
	it("supports soft closing when nullable last-order time is absent", async () => {
		await env.DB.prepare("UPDATE store_settings SET last_order_time=NULL WHERE id=1").run();
		expect((await post("online", "null-cutoff-open")).status).toBe(201);
		vi.setSystemTime(new Date("2026-10-06T23:15:00+08:00"));
		expect((await post("onsite", "null-cutoff-closed")).status).toBe(201);
	});
	it("honors an earlier configured last-order time", async () => {
		await env.DB.prepare("UPDATE store_settings SET last_order_time='23:00' WHERE id=1").run();
		vi.setSystemTime(new Date("2026-10-06T23:00:00+08:00"));
		expect((await post("online", "early-cutoff")).status).toBe(409);
	});
	it("does not extend business closing time with a later cutoff", async () => {
		const schedule = structuredClone(orderTestSchedule); schedule["2"]!.closeAt="22:00";
		await env.DB.prepare("UPDATE store_settings SET weekly_business_hours=? WHERE id=1").bind(JSON.stringify(schedule)).run();
		vi.setSystemTime(new Date("2026-10-06T22:00:00+08:00"));
		expect((await post("online", "early-close")).status).toBe(409);
	});
	it("guards a schedule change without a state-version change inside the atomic INSERT", async () => {
		let batches=0;
		const db = new Proxy(env.DB, { get(target, property) {
			if (property === "batch") return async (statements: D1PreparedStatement[]) => {
				if (++batches === 2) {
					const schedule=structuredClone(orderTestSchedule); schedule["2"]!.isOpen=false;
					await target.prepare("UPDATE store_settings SET weekly_business_hours=? WHERE id=1").bind(JSON.stringify(schedule)).run();
				}
				return target.batch(statements);
			};
			const value=Reflect.get(target,property); return typeof value === "function" ? value.bind(target) : value;
		} });
		const quoteFingerprint=await fingerprint();
		await expect(createOrder(db,{customerName:"Local",customerPhone:"Local",items,specialOrder:false,quoteFingerprint},"schedule-race",new Date("2026-10-06T18:00:00+08:00")))
			.rejects.toMatchObject({code:"BUSINESS_HOURS_CLOSED",status:409});
		expect(await state()).toMatchObject({orders:0,items:0,push:0,state_version:11,missed_order_count:0,is_accepting_orders:1});
	});
	it("leaves pending/preparing unchanged at cutoff and still allows Merchant completion", async () => {
		vi.setSystemTime(new Date("2026-10-06T23:14:59+08:00"));
		await post("online","existing-pending"); await post("onsite","existing-preparing");
		const preparing=await env.DB.prepare("SELECT id FROM orders WHERE idempotency_key='existing-preparing'").first<{id:string}>();
		await transitionMerchantOrder(env.DB,preparing!.id,"accept",new Date());
		const snapshot=(await env.DB.prepare("SELECT id,status,estimated_ready_at,accepted_at,rejected_at,completed_at FROM orders ORDER BY id").all()).results;
		const before=await state();
		vi.setSystemTime(new Date("2026-10-06T23:15:00+08:00"));
		expect((await quote()).status).toBe(200);
		expect((await env.DB.prepare("SELECT id,status,estimated_ready_at,accepted_at,rejected_at,completed_at FROM orders ORDER BY id").all()).results).toEqual(snapshot);
		expect(await state()).toEqual(before);
		expect(await listActiveMerchantOrders(env.DB,new Date())).toMatchObject([{status:"pending"},{status:"accepted"}]);
		await transitionMerchantOrder(env.DB,preparing!.id,"complete",new Date("2026-10-06T23:16:00+08:00"));
		expect(await env.DB.prepare("SELECT status FROM orders WHERE id=?").bind(preparing!.id).first()).toEqual({status:"completed"});
		expect(await state()).toMatchObject({is_accepting_orders:1,state_version:11,missed_order_count:0,missed_events:0});
	});
});
