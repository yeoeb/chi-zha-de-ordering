import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/react-app/App";
import { ORDER_ATTEMPT_STORAGE_KEY, serializeOrderAttempt } from "../src/react-app/order-attempt";
import { uiCopy } from "../src/react-app/ui-copy";

beforeEach(() => { vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(new Date("2026-10-06T18:00:00+08:00")); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null,"","/"); });
const storedKey=ORDER_ATTEMPT_STORAGE_KEY+":onsite";
function mockApi(orderStatus=201, quoteStatus=200, orderCode="IDEMPOTENCY_KEY_CONFLICT") {
	return vi.fn(async (input:RequestInfo|URL, init?:RequestInit) => {
		const url=String(input);
		const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
		if(url==="/api/store")return json({display_name:"吃炸的",is_accepting_orders:true,customerPhoneMode:"optional"});
		if(url==="/api/menu")return json({categories:[{id:1,name:"炸物",items:[{id:990,name:"測試餐點",description:"",price:60,isAvailable:true,modifierGroups:[]}]}]});
		if(url==="/api/checkout/quote")return quoteStatus===200?json({items:[{menuItemId:990,name:"測試餐點",quantity:1,unitPrice:60,lineTotal:60,modifiers:[]}],total:60,leadMinutes:20,estimatedReadyAt:"2026-10-06T10:20:00Z",quoteFingerprint:"a".repeat(64)}):json({error:{code:"BUSINESS_HOURS_CLOSED"}},quoteStatus);
		if(url==="/api/onsite/orders") {
			if(orderStatus!==201)return json({error:{code:orderStatus===409?orderCode:"INTERNAL_ERROR"}},orderStatus);
			return json({order:{publicLookupToken:"b".repeat(64),orderNumber:"LOCAL-RECOVERY",status:"pending",orderSource:"onsite",total:60,createdAt:"2026-10-06T10:00:00Z",estimatedReadyAt:"2026-10-06T10:20:00Z",items:[],customerNote:null,packagingPreference:"together"}},201);
		}
		if(url.startsWith("/api/orders/by-token/"))return json({error:{code:"ORDER_NOT_FOUND"}},404);
		throw new Error("Unexpected "+init?.method+" "+url);
	});
}
async function checkout(fetchMock: ReturnType<typeof mockApi>) {
	window.history.replaceState(null,"","/onsite");vi.stubGlobal("fetch",fetchMock);render(<App/>);
	await userEvent.click(await screen.findByRole("button",{name:"加入 測試餐點"}));
	await userEvent.click(screen.getByRole("button",{name:/購物車共 1 件/}));
	await userEvent.click(screen.getByRole("button",{name:"去結帳"}));
	await screen.findByRole("heading",{name:"確認訂單"});
}
function attempts(mock:ReturnType<typeof mockApi>){return mock.mock.calls.filter(([url])=>url==="/api/onsite/orders");}
describe("onsite stale pending-attempt regression",()=>{
	it("clears only a definite new-order cutoff rejection and shows business hours, without pausing Store",async()=>{
		const fetchMock=mockApi(409,200,"BUSINESS_HOURS_CLOSED");await checkout(fetchMock);
		await userEvent.click(await screen.findByRole("button",{name:"確認下單"}));
		expect(await screen.findByText(uiCopy.customer.businessHoursClosed)).toBeTruthy();
		expect(screen.queryByText(uiCopy.customer.orderStorePaused)).toBeNull();
		expect(attempts(fetchMock)).toHaveLength(1);
		expect(localStorage.getItem(storedKey)).toBeNull();
	});

	it("recovers a mismatched stored client hash using the same key and the authoritative API",async()=>{
		localStorage.setItem(storedKey,serializeOrderAttempt("f".repeat(64),"old-onsite-attempt"));
		const fetchMock=mockApi();await checkout(fetchMock);
		await userEvent.click(await screen.findByRole("button",{name:"確認下單"}));
		await screen.findByText("等待店家接單");
		expect(attempts(fetchMock)).toHaveLength(1);
		expect(new Headers(attempts(fetchMock)[0][1]?.headers).get("Idempotency-Key")).toBe("old-onsite-attempt");
		expect(JSON.parse(String(attempts(fetchMock)[0][1]?.body))).not.toHaveProperty("shortagePolicy");
		expect(localStorage.getItem(storedKey)).toBeNull();
		expect(screen.queryByText(uiCopy.customer.pendingAttemptBlocked)).toBeNull();
	});
	it("retains the same key after an authoritative conflict, with no fresh-key submission",async()=>{
		localStorage.setItem(storedKey,serializeOrderAttempt("f".repeat(64),"committed-original"));
		const fetchMock=mockApi(409);await checkout(fetchMock);
		for(let i=0;i<2;i++) {await userEvent.click(await screen.findByRole("button",{name:"確認下單"}));await screen.findByText(uiCopy.customer.attemptMismatch);}
		expect(attempts(fetchMock)).toHaveLength(2);
		for(const [,init] of attempts(fetchMock))expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("committed-original");
		expect(JSON.parse(localStorage.getItem(storedKey)!)).toMatchObject({idempotencyKey:"committed-original"});
	});
	it("keeps unknown outcomes recoverable using one bounded same-key retry",async()=>{
		localStorage.setItem(storedKey,serializeOrderAttempt("f".repeat(64),"unknown-original"));
		const fetchMock=mockApi(500);await checkout(fetchMock);
		await userEvent.click(await screen.findByRole("button",{name:"確認下單"}));
		await screen.findByText(uiCopy.customer.orderUnknown);
		await waitFor(()=>expect(attempts(fetchMock)).toHaveLength(2));
		for(const [,init] of attempts(fetchMock))expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("unknown-original");
		expect(JSON.parse(localStorage.getItem(storedKey)!)).toMatchObject({idempotencyKey:"unknown-original"});
	});
	it("shows a normal business-hours message when Quote rejects without claiming Store is paused",async()=>{
		const fetchMock=mockApi(201,409);await checkout(fetchMock);
		expect(await screen.findByText(uiCopy.customer.businessHoursClosed)).toBeTruthy();
		expect(screen.queryByText(uiCopy.customer.quoteStorePaused)).toBeNull();
		expect(attempts(fetchMock)).toHaveLength(0);
	});
});
