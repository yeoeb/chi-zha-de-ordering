import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../src/worker/index";
import { authenticateAdminRequest, authenticateMerchantRequest, isMerchantMutationRequestAllowed, type SecurityBindings } from "../src/worker/security";

const oldHost = "chi-zha-de-ordering.yeoeb55688.workers.dev";
const newHost = "chizhade.com";
const hosts = [oldHost, newHost];
const shared = { expectedHostname: oldHost, expectedHostnames: hosts, accessTeamDomain: "https://team.cloudflareaccess.com" };

describe("parallel custom-domain Access and Origin boundary", () => {
	it.each(hosts)("accepts a Merchant identity on exact %s", async (hostname) => {
		expect(await authenticateMerchantRequest({ ...shared, requestUrl: `https://${hostname}/api/merchant/orders`, accessAudience: "merchant-aud", accessToken: "merchant-token", verifyAccessIdentity: async (token, _team, aud) => token === "merchant-token" && aud === "merchant-aud" ? { subject: "merchant" } : null })).toEqual({ subject: "merchant" });
	});
	it.each(hosts)("accepts an Admin identity on exact %s", async (hostname) => {
		expect(await authenticateAdminRequest({ ...shared, requestUrl: `https://${hostname}/api/admin/store`, accessAudience: "admin-aud", accessToken: "admin-token", verifyAccessIdentity: async (token, _team, aud) => token === "admin-token" && aud === "admin-aud" ? { subject: "admin" } : null })).toEqual({ subject: "admin" });
	});
	it.each(["evil.example", `${oldHost}.evil.example`, `${newHost}.evil.example`, `sub.${newHost}`])("rejects unlisted hostname %s even with a valid identity", async (hostname) => {
		expect(await authenticateMerchantRequest({ ...shared, requestUrl: `https://${hostname}/api/merchant/orders`, accessAudience: "merchant-aud", accessToken: "merchant-token", verifyAccessIdentity: async () => ({ subject: "merchant" }) })).toBeNull();
	});
	it("keeps Merchant and Admin audiences separate on the new hostname", async () => {
		expect(await authenticateAdminRequest({ ...shared, requestUrl: `https://${newHost}/api/admin/store`, accessAudience: "admin-aud", accessToken: "merchant-token", verifyAccessIdentity: async (_token, _team, aud) => aud === "merchant-aud" ? { subject: "merchant" } : null })).toBeNull();
	});
	it.each(hosts)("accepts exact same-origin mutations on %s", (hostname) => {
		expect(isMerchantMutationRequestAllowed({ ...shared, method: "POST", requestUrl: `https://${hostname}/api/merchant/store/resume`, origin: `https://${hostname}`, secFetchSite: "same-origin" })).toBe(true);
	});
	it.each([`https://${oldHost}`, "https://evil.example", `https://${oldHost}.evil.example`, `https://${newHost}.evil.example`, `http://${newHost}`, `https://${newHost}/`, `https://${newHost}:443`, `https://user@${newHost}`, "null"])("rejects non-exact or cross-host Origin %s on the new host", (origin) => {
		expect(isMerchantMutationRequestAllowed({ ...shared, method: "POST", requestUrl: `https://${newHost}/api/merchant/store/resume`, origin, secFetchSite: "same-origin" })).toBe(false);
	});
	it("rejects cross-site Fetch Metadata even with an allowlisted origin", () => {
		expect(isMerchantMutationRequestAllowed({ ...shared, method: "POST", requestUrl: `https://${newHost}/api/admin/store`, origin: `https://${newHost}`, secFetchSite: "cross-site" })).toBe(false);
	});
	it("fails closed for wildcard configuration", async () => {
		expect(await authenticateMerchantRequest({ ...shared, expectedHostnames: [`*.${newHost}`], requestUrl: `https://${oldHost}/api/merchant/orders`, accessAudience: "merchant-aud", accessToken: "merchant-token", verifyAccessIdentity: async () => ({ subject: "merchant" }) })).toBeNull();
	});
	it.each(hosts.flatMap(host => ["/api/merchant/orders", "/api/admin/store"].map(route => [host, route])))("protects unauthenticated %s%s without local bypass", async (host, route) => {
		const response = await app.request(new Request(`https://${host}${route}`), undefined, { DB: env.DB, ORDER_RATE_LIMITER: env.ORDER_RATE_LIMITER, MERCHANT_HOSTNAME: oldHost, MERCHANT_HOSTNAMES: hosts.join(","), ADMIN_HOSTNAME: oldHost, ADMIN_HOSTNAMES: hosts.join(",") } as Env & SecurityBindings, {} as ExecutionContext);
		expect(response.status).toBe(403);
		expect(response.headers.get("Cache-Control")).toContain("no-store");
	});
	it.each(hosts)("serves public health and menu on %s", async (host) => {
		for (const route of ["/api/health", "/api/menu"]) {
			const response = await app.request(new Request(`https://${host}${route}`), undefined, { DB: env.DB } as Env, {} as ExecutionContext);
			expect(response.status).toBe(200);
		}
	});
	it.each(hosts)("retains Customer exact same-origin confirmation on %s before D1 mutation", async (host) => {
		const route = `https://${host}/api/orders/by-token/${"f".repeat(64)}/cancel`;
		for (const [origin, expected] of [[`https://${host}`, 400], ["https://evil.example", 403]] as const) {
			const response = await app.request(new Request(route, { method: "POST", headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: "{}" }), undefined, { DB: env.DB } as Env, {} as ExecutionContext);
			expect(response.status).toBe(expected);
		}
	});
});
