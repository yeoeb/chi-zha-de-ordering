import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/worker/index";
import { createQuoteFingerprint, validateAndPriceCart } from "../src/worker/checkout-quote";
import { createOrder, parseCreateOrderRequest } from "../src/worker/order-creation";
import { isPublicMutationRequestAllowed } from "../src/worker/public-origin";
import { setupOrderAcceptanceTests } from "./order-acceptance-fixture";

const hosts = ["chi-zha-de-ordering.yeoeb55688.workers.dev", "chizhade.com"];
const routes = ["/api/orders", "/api/onsite/orders"];
const items = [{ menuItemId: 990, quantity: 1, modifierOptionIds: [] }];
setupOrderAcceptanceTests();
beforeAll(async () => {
	await env.DB.batch([
		env.DB.prepare("INSERT INTO menu_categories(id,name,sort_order,is_active) VALUES(990,'Origin test',990,1)"),
		env.DB.prepare("INSERT INTO menu_items(id,category_id,name,description,price,sort_order,is_available) VALUES(990,990,'Origin test','',60,990,1)"),
	]);
});

async function fingerprint() { return createQuoteFingerprint(await validateAndPriceCart(env.DB, items)); }
async function snapshot() {
	const { results: tables } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name").all<{ name: string }>();
	return Promise.all(tables.map(async ({ name }) => ({ name, rows: (await env.DB.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()).results })));
}
function headers(host: string) {
	return { "Content-Type": "application/json", Origin: `https://${host}`, "Sec-Fetch-Site": "same-origin", "Idempotency-Key": crypto.randomUUID() };
}
async function pendingOrder() {
	return createOrder(env.DB, parseCreateOrderRequest({ items, specialOrder: false, quoteFingerprint: await fingerprint() }, "onsite"), crypto.randomUUID(), new Date());
}

describe("canonical public mutation Origin policy", () => {
	it.each(hosts)("accepts exact same-origin on %s", host => {
		expect(isPublicMutationRequestAllowed({ requestUrl: `https://${host}/api/orders`, origin: `https://${host}`, secFetchSite: "same-origin" })).toBe(true);
	});
	for (const host of hosts) {
		const otherHost = hosts.find(value => value !== host)!;
		it.each([undefined, "null", "invalid", "https://evil.invalid", `https://${otherHost}`, `https://${host}.evil.invalid`, `https://user@${host}`, `https://${host}/`, `https://${host}/path`, `https://${host}?query=1`, `https://${host}#fragment`, `https://${host}:443`, `https://${host}:444`, `http://${host}`, `https://${host.toUpperCase()}`])(`${host} rejects non-canonical Origin %s`, origin => {
			expect(isPublicMutationRequestAllowed({ requestUrl: `https://${host}/api/orders`, origin, secFetchSite: "same-origin" })).toBe(false);
		});
		it.each([undefined, "none", "same-site", "cross-site", "invalid", "same-origin, cross-site"])(`${host} rejects untrusted Fetch Metadata %s`, secFetchSite => {
			expect(isPublicMutationRequestAllowed({ requestUrl: `https://${host}/api/orders`, origin: `https://${host}`, secFetchSite })).toBe(false);
		});
	}
	it.each(["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"])("preserves exact loopback browser development %s", origin => {
		expect(isPublicMutationRequestAllowed({ requestUrl: `${origin}/api/orders`, origin, secFetchSite: "same-origin" })).toBe(true);
	});
	it.each(["http://chizhade.com", "https://chizhade.com:444", "data:text/plain,invalid"])("rejects untrusted request origin %s", origin => {
		expect(isPublicMutationRequestAllowed({ requestUrl: origin, origin, secFetchSite: "same-origin" })).toBe(false);
	});
});

describe("public create-order side-effect boundary", () => {
	for (const host of hosts) for (const route of routes) {
		it.each(["missing", "unknown", "cross-host"])(`${host}${route} blocks the original %s Origin reproduction before all D1 effects`, async kind => {
			const requestHeaders: Record<string, string> = { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site", "Idempotency-Key": crypto.randomUUID() };
			if (kind !== "missing") requestHeaders.Origin = kind === "unknown" ? "https://evil.invalid" : `https://${hosts.find(value => value !== host)}`;
			const body = JSON.stringify({ items, specialOrder: false, quoteFingerprint: await fingerprint() });
			const before = await snapshot();
			const response = await exports.default.fetch(`https://${host}${route}`, { method: "POST", headers: requestHeaders, body });
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({ error: { code: "ORIGIN_DENIED" } });
			expect(await snapshot()).toEqual(before);
		});
		it(`${host}${route} preserves legitimate browser pricing/source/replay`, async () => {
			const requestHeaders = headers(host);
			const body = JSON.stringify({ items, specialOrder: false, quoteFingerprint: await fingerprint() });
			const first = await exports.default.fetch(`https://${host}${route}`, { method: "POST", headers: requestHeaders, body });
			expect(first.status).toBe(201);
			expect(await first.json()).toMatchObject({ order: { orderSource: route.includes("onsite") ? "onsite" : "online", total: 60, status: "pending" } });
			const beforeReplay = await snapshot();
			const replay = await exports.default.fetch(`https://${host}${route}`, { method: "POST", headers: requestHeaders, body });
			expect(replay.status).toBe(200);
			expect(await snapshot()).toEqual(beforeReplay);
		});
	}
	it.each(hosts.flatMap(host => routes.map(route => [host, route])))("%s%s rejects before even reading DB or invoking rate limiting", async (host, route) => {
		let dbCalls = 0;
		let limiterCalls = 0;
		const DB = new Proxy({}, { get() { dbCalls++; throw new Error("D1 must not be accessed"); } });
		const response = await app.request(new Request(`https://${host}${route}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.invalid", "Sec-Fetch-Site": "same-origin" }, body: "{}" }), undefined, { DB, ORDER_RATE_LIMITER: { limit: async () => { limiterCalls++; return { success: true }; } } } as unknown as Env, {} as ExecutionContext);
		expect(response.status).toBe(403);
		expect(dbCalls).toBe(0);
		expect(limiterCalls).toBe(0);
	});
});

describe("public cancellation canonical Origin boundary", () => {
	for (const host of hosts) {
		it(`${host} rejects the original credentials/path/query reproduction without changing any D1 table`, async () => {
			const { order } = await pendingOrder();
			const before = await snapshot();
			const response = await exports.default.fetch(`https://${host}/api/orders/by-token/${order.publicLookupToken}/cancel`, { method: "POST", headers: { ...headers(host), Origin: `https://user@${host}/fake?ignored=true` }, body: '{"confirm":true}' });
			expect(response.status).toBe(403);
			expect(await snapshot()).toEqual(before);
		});
		it.each(["cross-host", "missing Origin", "missing Fetch Metadata"])(`${host} rejects %s cancellation without changing any D1 table`, async kind => {
			const { order } = await pendingOrder();
			const requestHeaders: Record<string, string> = headers(host);
			if (kind === "cross-host") requestHeaders.Origin = `https://${hosts.find(value => value !== host)}`;
			if (kind === "missing Origin") delete requestHeaders.Origin;
			if (kind === "missing Fetch Metadata") delete requestHeaders["Sec-Fetch-Site"];
			const before = await snapshot();
			const response = await exports.default.fetch(`https://${host}/api/orders/by-token/${order.publicLookupToken}/cancel`, { method: "POST", headers: requestHeaders, body: '{"confirm":true}' });
			expect(response.status).toBe(403);
			expect(await snapshot()).toEqual(before);
		});
		it.each(["online", "onsite"] as const)(`${host} preserves legitimate %s cancellation`, async source => {
			const route = source === "online" ? "/api/orders" : "/api/onsite/orders";
			const created = await exports.default.fetch(`https://${host}${route}`, { method: "POST", headers: headers(host), body: JSON.stringify({ items, specialOrder: false, quoteFingerprint: await fingerprint() }) });
			expect(created.status).toBe(201);
			const { order } = await created.json() as { order: { publicLookupToken: string } };
			const response = await exports.default.fetch(`https://${host}/api/orders/by-token/${order.publicLookupToken}/cancel`, { method: "POST", headers: headers(host), body: '{"confirm":true}' });
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ order: { status: "cancelled", cancellationReason: "customer_cancelled" } });
		});
	}
});
