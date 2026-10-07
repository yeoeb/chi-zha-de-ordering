import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import MerchantView from "../src/react-app/MerchantView";
import { MerchantForegroundAudioController } from "../src/react-app/merchant-audio";
import { getStoreBusinessDate } from "../src/shared/business-date";

type MenuItem = { id: number; name: string; isAvailable: boolean; isQuickSoldOut?: boolean };

function json(value: unknown, status = 200) {
	return Promise.resolve(
		new Response(JSON.stringify(value), {
			status,
			headers: { "content-type": "application/json" },
		}),
	);
}

function installFakeAudioContext({ resumeFails = false } = {}) {
	const starts = vi.fn();
	const contexts: Array<{
		state: AudioContextState;
		resume: ReturnType<typeof vi.fn>;
		suspendForTest: () => void;
	}> = [];
	class FakeAudioContext {
		state: AudioContextState = "suspended";
		currentTime = 0;
		destination = {};
		private stateListeners: Array<() => void> = [];
		resume = vi.fn(async () => {
			if (resumeFails) throw new Error("blocked");
			this.state = "running";
			this.stateListeners.forEach((listener) => listener());
		});
		close = vi.fn(async () => {
			this.state = "closed";
		});
		createOscillator() {
			return {
				frequency: { setValueAtTime: vi.fn() },
				connect: vi.fn(),
				disconnect: vi.fn(),
				start: starts,
				stop: vi.fn(),
			};
		}
		createGain() {
			return {
				gain: {
					setValueAtTime: vi.fn(),
					exponentialRampToValueAtTime: vi.fn(),
				},
				connect: vi.fn(),
				disconnect: vi.fn(),
			};
		}
		addEventListener(type: string, listener: () => void) {
			if (type === "statechange") this.stateListeners.push(listener);
		}
		suspendForTest() {
			this.state = "suspended";
			this.stateListeners.forEach((listener) => listener());
		}
		constructor() {
			contexts.push(this);
		}
	}
	vi.stubGlobal("AudioContext", FakeAudioContext);
	return { starts, contexts };
}

function installWebPush({
	permission = "default" as NotificationPermission,
	requestResult = "granted" as NotificationPermission,
	getSubscriptionResults = [null] as Array<PushSubscription | null>,
} = {}) {
	const subscription = {
		endpoint: "https://push.example.test/subscription",
		toJSON: vi.fn(() => ({
			endpoint: "https://push.example.test/subscription",
			keys: { p256dh: "test-p256dh", auth: "test-auth" },
		})),
		unsubscribe: vi.fn(async () => true),
	} as unknown as PushSubscription;
	let currentPermission = permission;
	const notification = {
		get permission() { return currentPermission; },
		requestPermission: vi.fn(async () => {
			currentPermission = requestResult;
			return requestResult;
		}),
	};
	const pushManager = {
		getSubscription: vi.fn(),
		subscribe: vi.fn(async () => subscription),
	};
	for (const result of getSubscriptionResults) pushManager.getSubscription.mockResolvedValueOnce(result);
	pushManager.getSubscription.mockResolvedValue(getSubscriptionResults.at(-1) ?? null);
	const registration = { pushManager };
	Object.defineProperty(navigator, "serviceWorker", {
		configurable: true,
		value: { controller: {}, ready: Promise.resolve(registration) },
	});
	vi.stubGlobal("PushManager", class PushManager {});
	vi.stubGlobal("Notification", notification);
	return { notification, pushManager, subscription, registration };
}

function order(overrides: Record<string, unknown> = {}) {
	return {
		id: "order-023",
		orderNumber: "023",
		status: "pending",
		total: 185,
		estimatedReadyAt: "2026-09-16T11:56:00.000Z",
		createdAt: "2026-09-16T11:40:00.000Z",
		customerName: "王小明",
		customerPhone: "0912345678",
		customerNote: "雞排不要切",
		packagingPreference: "separate_spicy",
		specialOrder: false,
		items: [
			{
				id: "line-chicken-medium",
				menuItemId: 1,
				name: "香雞排",
				quantity: 1,
				lineTotal: 70,
				modifiers: [
					{ groupName: "辣度", name: "中辣" },
					{ groupName: "切法", name: "切" },
				],
			},
			{
				id: "line-chicken-none",
				menuItemId: 1,
				name: "香雞排",
				quantity: 1,
				lineTotal: 70,
				modifiers: [
					{ groupName: "辣度", name: "不辣" },
					{ groupName: "切法", name: "不切" },
				],
			},
			{
				id: "line-fries",
				menuItemId: 9,
				name: "薯條",
				quantity: 1,
				lineTotal: 45,
				modifiers: [
					{ groupName: "調味", name: "胡椒" },
					{ groupName: "特殊選項：不加醬", name: "不加醬" },
				],
			},
		],
		...overrides,
	};
}

function getOrderCard(id = "order-023") {
	return screen.getByTestId(`merchant-order-${id}`);
}

function findOrderCard(id = "order-023") {
	return screen.findByTestId(`merchant-order-${id}`);
}

function createFetchMock({
	orders = [order()],
	historyOrders = [],
	historyOrdersByDate,
	orderActionStatus,
	failAfterFirstPoll = false,
	orderPollSequence,
	newOrderSoundEnabled = true,
	pushSaveStatus = 200,
	pushDeleteStatus = 200,
}: {
	orders?: Array<Record<string, unknown>>;
	historyOrders?: Array<Record<string, unknown>>;
	historyOrdersByDate?: Record<string, Array<Record<string, unknown>>>;
	orderActionStatus?: number;
	failAfterFirstPoll?: boolean;
	orderPollSequence?: Array<Array<Record<string, unknown>>>;
	newOrderSoundEnabled?: boolean;
	pushSaveStatus?: number;
	pushDeleteStatus?: number;
} = {}) {
	let orderPolls = 0;
	let activeOrders = [...orders];
	let history: Array<Record<string, unknown>> = [...historyOrders];
	let items: MenuItem[] = [
		{ id: 1, name: "香雞排", isAvailable: true },
		{ id: 2, name: "青椒", isAvailable: false },
	];
	let storeSnapshot = {
		display_name: "吃炸的",
		is_accepting_orders: true,
		stateVersion: 1,
		busyMode: false,
		missedOrderCount: 0,
		autoPauseReason: null,
		newOrderSoundEnabled,
	};

	const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");

		if (url === "/api/merchant/orders" && method === "GET") {
			orderPolls += 1;
			if (failAfterFirstPoll && orderPolls > 1) return json({}, 503);
			if (orderPollSequence) {
				activeOrders = orderPollSequence[Math.min(orderPolls - 1, orderPollSequence.length - 1)];
			}
			return json({ orders: activeOrders });
		}
		if (url.startsWith("/api/merchant/orders/history?") && method === "GET") {
			const businessDate = new URL(url, "https://local.test").searchParams.get("date") ?? "";
			return json({ businessDate, history: historyOrdersByDate?.[businessDate] ?? history });
		}
		if (url === "/api/merchant/notifications" && method === "GET") return json({ deliveries: [] });
		if (url === "/api/merchant/push/public-key" && method === "GET") return json({ publicKey: "AQ" });
		if (url === "/api/merchant/push/subscriptions" && method === "POST") return json({ subscribed: true }, pushSaveStatus);
		if (url === "/api/merchant/push/subscriptions" && method === "DELETE") return json({ subscribed: false }, pushDeleteStatus);
		if (url === "/api/merchant/revenue" && method === "GET") return json({
			businessDate: "2026-09-16",
			revenue: 185,
			effectiveOrderCount: 1,
			averageOrderValue: 185,
			itemQuantity: 3,
			topItems: [{ name: "香雞排", quantity: 2 }],
			busiestHour: "19:00–19:59",
			cancelledCount: 0,
			rejectedCount: 0,
			soldOutItems: [{ id: 2, name: "青椒" }],
		});
		if (url === "/api/store" && method === "GET") {
			return json(storeSnapshot);
		}
		if (url === "/api/merchant/store/busy-mode" && method === "POST") {
			const body = JSON.parse(String(init?.body)) as { busyMode: boolean };
			storeSnapshot = { ...storeSnapshot, busyMode: body.busyMode, stateVersion: storeSnapshot.stateVersion + 1 };
			return json({ outcome: "APPLIED", extendedOrderCount: body.busyMode ? 1 : 0 });
		}
		if (url === "/api/menu" && method === "GET") {
			return json({ categories: [{ id: 1, name: "炸物", items }] });
		}
		const actionMatch = url.match(/^\/api\/merchant\/orders\/([^/]+)\/(accept|reject|complete)$/);
		if (actionMatch && method === "POST") {
			if (orderActionStatus) {
				const code = orderActionStatus === 403
					? "ORIGIN_DENIED"
					: orderActionStatus === 409
						? "ILLEGAL_ORDER_TRANSITION"
						: "FAILED";
				return json({ error: { code } }, orderActionStatus);
			}
			const [, orderId, action] = actionMatch;
			const current = activeOrders.find((candidate) => candidate.id === orderId);
			if (!current) return json({ error: { code: "ORDER_NOT_FOUND" } }, 404);
			const status = action === "accept" ? "accepted" : action === "reject" ? "rejected" : "completed";
			const updated = { ...current, status };
			activeOrders = action === "accept"
				? activeOrders.map((candidate) => candidate.id === orderId ? updated : candidate)
				: activeOrders.filter((candidate) => candidate.id !== orderId);
			if (action !== "accept") history = [updated, ...history];
			return json({ order: updated });
		}
		const shortageMatch = url.match(/^\/api\/merchant\/orders\/([^/]+)\/shortages$/);
		if (shortageMatch && method === "POST") {
			const body = JSON.parse(String(init?.body)) as { items: Array<{ orderItemId: string; quantity: number }> };
			const current = activeOrders.find((candidate) => candidate.id === shortageMatch[1]);
			if (!current) return json({ error: { code: "ORDER_NOT_FOUND" } }, 404);
			const currentItems = current.items as Array<Record<string, unknown>>;
			const shortage = body.items[0]!;
			const targeted = currentItems.find((candidate) => candidate.id === shortage.orderItemId);
			if (!targeted) return json({ error: { code: "ORDER_ITEM_NOT_FOUND" } }, 422);
			const menuItemId = Number(targeted.menuItemId);
			items = items.map((item) => item.id === menuItemId ? { ...item, isAvailable: false } : item);
			const updated = {
				...current,
				total: Number(current.total) - (Number(targeted.lineTotal) / Number(targeted.quantity)) * shortage.quantity,
				items: currentItems.map((candidate) => candidate.id === shortage.orderItemId
					? { ...candidate, quantity: Number(candidate.quantity) - shortage.quantity }
					: candidate),
			};
			activeOrders = activeOrders.map((candidate) => candidate.id === current.id ? updated : candidate);
			return json({ order: updated });
		}
		if (url === "/api/merchant/menu-items/1/sold-out" && method === "POST") {
			items = items.map((item) => item.id === 1 ? { ...item, isAvailable: false } : item);
			return json({ item: items[0] });
		}
		if (url === "/api/merchant/menu-items/1/restore" && method === "POST") {
			items = items.map((item) => item.id === 1 ? { ...item, isAvailable: true } : item);
			return json({ item: items[0] });
		}
		throw new Error(`Unexpected request: ${method} ${url}`);
	});

	return mock;
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	localStorage.clear();
	Reflect.deleteProperty(navigator, "serviceWorker");
	window.history.replaceState(null, "", "/merchant");
});

describe("Merchant operations UI", () => {
	it("removes audio settings and silently unlocks once across normal touch, click and keyboard gestures", async () => {
		const audio = installFakeAudioContext();
		const activation = vi.spyOn(MerchantForegroundAudioController.prototype, "activate");
		vi.stubGlobal("fetch", createFetchMock());
		render(<MerchantView />);
		await findOrderCard();
		expect(screen.queryByText("接單提示音")).toBeNull();
		expect(screen.queryByText("尚未啟用")).toBeNull();
		expect(screen.queryByRole("button", { name: /啟用接單提示音|測試提示音/ })).toBeNull();
		expect(document.querySelector("[data-audio-state]")).toBeNull();
		expect(audio.contexts).toHaveLength(0);
		const tab = screen.getByRole("button", { name: /^待接單/ });
		fireEvent.touchEnd(tab);
		await userEvent.click(tab);
		tab.focus();
		await userEvent.keyboard("{Enter}");
		await userEvent.click(screen.getByRole("button", { name: "售罄" }));
		expect(activation).toHaveBeenCalledExactlyOnceWith(false);
		expect(audio.contexts).toHaveLength(1);
		expect(audio.contexts[0]?.resume).toHaveBeenCalledTimes(1);
		expect(audio.starts).not.toHaveBeenCalled();
	});

	it("without any user gesture polling discovers pending Orders without creating or retrying audio", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const audio = installFakeAudioContext();
		vi.stubGlobal("fetch", createFetchMock({ orderPollSequence: [[order()], [order(), order({ id: "new-locked" })]] }));
		render(<MerchantView />);
		await findOrderCard();
		await vi.advanceTimersByTimeAsync(15_100);
		expect(await screen.findByRole("button", { name: /待接單 2/ })).toBeTruthy();
		expect(audio.contexts).toHaveLength(0);
		expect(audio.starts).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: /停止提示音/ })).toBeNull();
	});

	it.each(["reject", "shortage"])("system Back closes the %s secondary confirmation without posting a mutation", async (surface) => {
		const mock = createFetchMock();
		vi.stubGlobal("fetch", mock);
		render(<MerchantView />);
		const card = await findOrderCard();
		await userEvent.click(within(card).getAllByRole("button", { name: surface === "reject" ? "拒單" : "缺貨" })[0]);
		expect(screen.getByRole("dialog")).toBeTruthy();
		window.history.back();
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(window.location.pathname).toBe("/merchant");
		expect(screen.getByRole("button", { name: /^待接單/ }).getAttribute("aria-current")).toBe("page");
		expect(mock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
	});

	it.each([
		["製作中", "歷史訂單", "system"],
		["售罄", "營業額", "system"],
		["製作中", "營業額", "visible"],
		["售罄", "歷史訂單", "visible"],
	])("%s → %s → %s Back resets the actual workbench to pending", async (tab, secondary, back) => {
		vi.stubGlobal("fetch", createFetchMock({ orders: [order(), order({ id: "accepted-for-navigation", status: "accepted", estimatedReadyAt: "2099-10-07T11:30:00.000Z" })] }));
		render(<MerchantView />);
		await findOrderCard();
		const tabs = screen.getByRole("navigation", { name: "店家主要功能" });
		await userEvent.click(within(tabs).getByRole("button", { name: new RegExp(`^${tab}`) }));
		await userEvent.click(screen.getByRole("button", { name: secondary }));
		await screen.findByRole("heading", { name: secondary });
		if (back === "system") window.history.back();
		else await userEvent.click(screen.getByRole("button", { name: "返回工作台" }));
		await waitFor(() => {
			expect(within(tabs).getByRole("button", { name: /^待接單/ }).getAttribute("aria-current")).toBe("page");
			expect(window.location.pathname).toBe("/merchant");
			expect(screen.queryByRole("heading", { name: secondary })).toBeNull();
		});
		expect(await findOrderCard()).toBeTruthy();
	});

	it("replaces workbench tab selections in one sentinel so system Back does not traverse stale tabs", async () => {
		vi.stubGlobal("fetch", createFetchMock());
		render(<MerchantView />);
		await findOrderCard();
		const tabs = screen.getByRole("navigation", { name: "店家主要功能" });
		await userEvent.click(within(tabs).getByRole("button", { name: /^製作中/ }));
		const length = window.history.length;
		await userEvent.click(within(tabs).getByRole("button", { name: "售罄" }));
		expect(window.history.length).toBe(length);
		window.history.back();
		await waitFor(() => expect(within(tabs).getByRole("button", { name: /^待接單/ }).getAttribute("aria-current")).toBe("page"));
	});

	it("reports a stalled audio resume instead of claiming readiness forever", async () => {
		vi.useFakeTimers();
		const audio = installFakeAudioContext();
		const states: string[] = [];
		const controller = new MerchantForegroundAudioController((state) => states.push(state));
		const activation = controller.activate();
		await activation;
		const context = audio.contexts[0];
		if (!context) throw new Error("AudioContext was not created");
		context.suspendForTest();
		context.resume.mockImplementation(() => new Promise<void>(() => undefined));
		const playback = controller.playAlert();
		await vi.advanceTimersByTimeAsync(2001);
		expect(await playback).toBe(false);
		expect(states.at(-1)).toBe("error");
		expect(audio.starts).toHaveBeenCalledTimes(2);
		controller.dispose();
	});

	it("requires session activation again after remount without sounding for existing Orders", async () => {
		const audio = installFakeAudioContext();
		vi.stubGlobal("fetch", createFetchMock());
		const first = render(<MerchantView />);
		await findOrderCard();
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));
		expect(audio.starts).toHaveBeenCalledTimes(0);
		first.unmount();
		render(<MerchantView />);
		await findOrderCard();
		expect(screen.queryByRole("button", { name: /啟用接單提示音/ })).toBeNull();
		expect(audio.contexts).toHaveLength(1);
		expect(audio.starts).toHaveBeenCalledTimes(0);
	});

	it("does not equate granted notification permission with an actual PushSubscription", async () => {
		const push = installWebPush({ permission: "granted", getSubscriptionResults: [null] });
		installFakeAudioContext();
		vi.stubGlobal("fetch", createFetchMock());
		render(<MerchantView />);
		await findOrderCard();
		expect(await screen.findByText("通知未開啟")).toBeTruthy();
		expect(screen.queryByText("通知已開啟")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));
		expect(push.notification.requestPermission).toHaveBeenCalledTimes(0);
	});

	it("diagnoses unsupported Web Push without requesting permission", async () => {
		vi.stubGlobal("fetch", createFetchMock());
		render(<MerchantView />);
		await findOrderCard();
		expect(screen.getByText("此環境不支援")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "開啟通知" })).toBeNull();
	});

	it("unlocks one persistent AudioContext and repeats one session for new pending batches, not repeated polling", async () => {
		const ring = vi.spyOn(MerchantForegroundAudioController.prototype, "startRing");
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const audio = installFakeAudioContext();
		const existing = order({ id: "existing" });
		const next = order({ id: "next" });
		const third = order({ id: "third" });
		const fourth = order({ id: "fourth" });
		vi.stubGlobal("fetch", createFetchMock({
			orderPollSequence: [
				[existing],
				[existing, next],
				[existing, next],
				[existing, next, third, fourth],
			],
		}));
		render(<MerchantView />);
		await findOrderCard("existing");
		expect(audio.contexts).toHaveLength(0);
		expect(audio.starts).toHaveBeenCalledTimes(0);

		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));
		expect(audio.contexts).toHaveLength(1);
		expect(audio.contexts[0]?.state).toBe("running");
		expect(audio.starts).toHaveBeenCalledTimes(0);
		expect(screen.queryByText("已啟用")).toBeNull();

		await vi.advanceTimersByTimeAsync(5_100);
		await screen.findByRole("button", { name: /待接單 2/ });
		expect(audio.starts.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(screen.getByRole("button", { name: /停止提示音/ })).toBeTruthy();
		expect(ring).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(5_100);
		expect(ring).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(5_100);
		await screen.findByRole("button", { name: /待接單 4/ });
		expect(ring).toHaveBeenCalledTimes(2);
		expect(audio.contexts).toHaveLength(1);
	});

	it("failed first gesture is non-fatal and polling never retries audio activation", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const audio = installFakeAudioContext({ resumeFails: true });
		const existing = order({ id: "existing" });
		const next = order({ id: "next" });
		vi.stubGlobal("fetch", createFetchMock({ orderPollSequence: [[existing], [existing, next]] }));
		render(<MerchantView />);
		await findOrderCard("existing");
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));
		await waitFor(() => expect(audio.contexts[0]?.resume).toHaveBeenCalledTimes(1));
		expect(screen.queryByRole("button", { name: /啟用接單提示音/ })).toBeNull();
		expect(audio.starts).toHaveBeenCalledTimes(0);

		await vi.advanceTimersByTimeAsync(5_100);
		expect(await screen.findByRole("button", { name: /待接單 2/ })).toBeTruthy();
		expect(audio.contexts[0]?.resume).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("button", { name: /停止提示音/ })).toBeNull();
	});

	it("manual stop acknowledges this session only, and a later new Order rings again", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const audio = installFakeAudioContext();
		const old = order({ id: "old" });
		const first = order({ id: "first" });
		const later = order({ id: "later" });
		vi.stubGlobal("fetch", createFetchMock({ orderPollSequence: [[old], [old, first], [old, first], [old, first, later]] }));
		const view = render(<MerchantView />);
		await findOrderCard("old");
		expect(screen.queryByRole("button", { name: /停止提示音/ })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));
		await vi.advanceTimersByTimeAsync(5100);
		await userEvent.click(await screen.findByRole("button", { name: /停止提示音/ }));
		expect(screen.queryByRole("button", { name: /停止提示音/ })).toBeNull();
		const stopped = audio.starts.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5100);
		expect(audio.starts).toHaveBeenCalledTimes(stopped);
		await vi.advanceTimersByTimeAsync(5100);
		expect(await screen.findByRole("button", { name: /停止提示音/ })).toBeTruthy();
		expect(audio.starts.mock.calls.length).toBeGreaterThan(stopped);
		expect(audio.contexts).toHaveLength(1);
		view.unmount();
		const afterUnmount = audio.starts.mock.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(audio.starts).toHaveBeenCalledTimes(afterUnmount);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("confirmed accept stops the whole ring even when another alerted pending Order remains", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const audio = installFakeAudioContext();
		const old = order({ id: "old" });
		const incoming = order({ id: "incoming" });
		const other = order({ id: "other-new" });
		const base = createFetchMock({ orders: [old, incoming, other] });
		let polls = 0;
		vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			if (input === "/api/merchant/orders" && ++polls === 1) return json({ orders: [old] });
			return base(input, init);
		}));
		render(<MerchantView />);
		await findOrderCard("old");
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));
		await vi.advanceTimersByTimeAsync(5100);
		expect(await screen.findByRole("button", { name: /停止提示音/ })).toBeTruthy();
		await userEvent.click(within(await findOrderCard("incoming")).getByRole("button", { name: "接單" }));
		expect(screen.queryByRole("button", { name: /停止提示音/ })).toBeNull();
		expect(audio.contexts[0]?.state).toBe("running");
		expect((await screen.findByRole("button", { name: /製作中 1/ })).getAttribute("aria-current")).toBe("page");
	});

	it("failed accept does not acknowledge a still-pending ringing Order", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		installFakeAudioContext();
		const old = order({ id: "old" });
		const incoming = order({ id: "incoming" });
		vi.stubGlobal("fetch", createFetchMock({ orderActionStatus: 403, orderPollSequence: [[old], [old, incoming]] }));
		render(<MerchantView />);
		await findOrderCard("old");
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));
		await vi.advanceTimersByTimeAsync(5100);
		await userEvent.click(within(await findOrderCard("incoming")).getByRole("button", { name: "接單" }));
		expect(screen.getByRole("button", { name: /停止提示音/ })).toBeTruthy();
		expect(within(await findOrderCard("incoming")).getByRole("button", { name: "接單" })).toBeTruthy();
	});

	it("authoritative removal on polling stops the alarm while unrelated pending Orders remain", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const audio = installFakeAudioContext();
		const old = order({ id: "old" });
		const incoming = order({ id: "incoming" });
		vi.stubGlobal("fetch", createFetchMock({ orderPollSequence: [[old], [old, incoming], [old]] }));
		render(<MerchantView />);
		await findOrderCard("old");
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));
		await vi.advanceTimersByTimeAsync(5100);
		expect(await screen.findByRole("button", { name: /停止提示音/ })).toBeTruthy();
		await vi.advanceTimersByTimeAsync(5100);
		await waitFor(() => expect(screen.queryByRole("button", { name: /停止提示音/ })).toBeNull());
		const stopped = audio.starts.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5100);
		expect(audio.starts).toHaveBeenCalledTimes(stopped);
	});

	it("recovers a suspended foreground AudioContext when the Merchant page becomes visible", async () => {
		const audio = installFakeAudioContext();
		vi.stubGlobal("fetch", createFetchMock());
		render(<MerchantView />);
		await findOrderCard();
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));
		const context = audio.contexts[0];
		if (!context) throw new Error("AudioContext was not created");
		context.suspendForTest();
		expect(context.state).toBe("suspended");
		expect(screen.queryByText("尚未啟用")).toBeNull();
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		document.dispatchEvent(new Event("visibilitychange"));
		await waitFor(() => expect(context.resume).toHaveBeenCalledTimes(2));
		expect(context.state).toBe("running");
	});

	it("normal gestures are silent and automatic alerts stay suppressed when Store sound is disabled", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const audio = installFakeAudioContext();
		const existing = order({ id: "existing" });
		const next = order({ id: "next" });
		vi.stubGlobal("fetch", createFetchMock({ orderPollSequence: [[existing], [existing, next]] }));
		const view = render(<MerchantView />);
		await findOrderCard("existing");
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));
		expect(audio.starts).toHaveBeenCalledTimes(0);
		view.unmount();

		const disabledAudio = installFakeAudioContext();
		vi.stubGlobal("fetch", createFetchMock({
			newOrderSoundEnabled: false,
			orderPollSequence: [[existing], [existing, next]],
		}));
		render(<MerchantView />);
		await findOrderCard("existing");
		expect(screen.queryByText("店家設定已關閉")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));
		expect(screen.queryByRole("button", { name: /啟用接單提示音/ })).toBeNull();
		await vi.advanceTimersByTimeAsync(5_100);
		expect(await screen.findByRole("button", { name: /待接單 2/ })).toBeTruthy();
		expect(disabledAudio.starts).toHaveBeenCalledTimes(0);
	});

	it("does not alert for a newly observed non-pending Order", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const audio = installFakeAudioContext();
		const existing = order({ id: "existing" });
		const completed = order({ id: "completed", status: "completed" });
		vi.stubGlobal("fetch", createFetchMock({ orderPollSequence: [[existing], [existing, completed]] }));
		render(<MerchantView />);
		await findOrderCard("existing");
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));
		expect(audio.starts).toHaveBeenCalledTimes(0);
		await vi.advanceTimersByTimeAsync(5_100);
		expect(audio.starts).toHaveBeenCalledTimes(0);
	});

	it("keeps notification permission user-triggered and reports denial", async () => {
		const push = installWebPush({ requestResult: "denied" });
		vi.stubGlobal("fetch", createFetchMock());
		render(<MerchantView />);
		await findOrderCard();
		expect(push.notification.requestPermission).toHaveBeenCalledTimes(0);
		await userEvent.click(screen.getByRole("button", { name: "開啟通知" }));
		expect(push.notification.requestPermission).toHaveBeenCalledTimes(1);
		expect(await screen.findByText("通知被拒絕")).toBeTruthy();
		expect(screen.getByText(/系統設定允許/)).toBeTruthy();
	});

	it("requires a persisted PushSubscription before showing notifications enabled and reuses an existing subscription", async () => {
		const existing = installWebPush({ getSubscriptionResults: [null] });
		existing.pushManager.getSubscription.mockReset()
			.mockResolvedValueOnce(null)
			.mockResolvedValue(existing.subscription);
		const fetchMock = createFetchMock();
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		await findOrderCard();
		expect(await screen.findByText("通知未開啟")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "開啟通知" }));
		expect(await screen.findByText("通知已開啟")).toBeTruthy();
		expect(existing.pushManager.subscribe).toHaveBeenCalledTimes(0);
		expect(fetchMock.mock.calls.some(([input, init]) => String(input) === "/api/merchant/push/subscriptions" && init?.method === "POST")).toBe(true);
	});

	it("does not claim Push is enabled when server persistence fails", async () => {
		const push = installWebPush({ getSubscriptionResults: [null, null] });
		vi.stubGlobal("fetch", createFetchMock({ pushSaveStatus: 503 }));
		render(<MerchantView />);
		await findOrderCard();
		await screen.findByText("通知未開啟");
		await userEvent.click(screen.getByRole("button", { name: "開啟通知" }));
		expect(await screen.findByText("通知開啟失敗，請確認網路與瀏覽器設定後再試。")).toBeTruthy();
		expect(screen.getByText("通知未開啟")).toBeTruthy();
		expect(push.subscription.unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("removes the server Push subscription before unsubscribing locally", async () => {
		const push = installWebPush();
		push.pushManager.getSubscription.mockReset().mockResolvedValue(push.subscription);
		const fetchMock = createFetchMock();
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		await findOrderCard();
		expect(await screen.findByText("通知已開啟")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "停用通知" }));
		expect(await screen.findByText("通知未開啟")).toBeTruthy();
		const deleteCall = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/merchant/push/subscriptions" && init?.method === "DELETE");
		expect(deleteCall).toBeTruthy();
		expect(push.subscription.unsubscribe).toHaveBeenCalledTimes(1);
	});

	it("has only 待接單, 製作中, and 售罄 as primary navigation and exposes no admin editing", async () => {
		vi.stubGlobal("fetch", createFetchMock());
		render(<MerchantView />);
		await findOrderCard();

		const navigation = screen.getByRole("navigation", { name: "店家主要功能" });
		expect(within(navigation).getAllByRole("button").map((button) => button.textContent)).toEqual([
			"待接單 1",
			"製作中 0",
			"售罄",
		]);
		for (const label of ["價格", "商品編輯", "商品管理", "圖片", "分類", "Modifier 設定", "Menu CRUD", "Admin"]) {
			expect(screen.queryByText(label)).toBeNull();
		}
		const activeCard = getOrderCard();
		expect(within(activeCard).getByText("網路")).toBeTruthy();
		expect(activeCard.classList.contains("source-online")).toBe(true);
		expect(within(activeCard).getByText("網路").classList.contains("source-online")).toBe(true);
		expect(within(activeCard).queryByText("王小明")).toBeNull();
		expect(within(activeCard).queryByText("0912345678")).toBeNull();
		expect(within(activeCard).queryByText("NT$ 185")).toBeNull();
		expect(within(activeCard).queryByText("訂單 #023")).toBeNull();
		expect(screen.queryByText("通知狀態")).toBeNull();
	});

	it("labels onsite work and shows the backend snapshot total only after acceptance", async () => {
		vi.stubGlobal("fetch", createFetchMock({
			orders: [order({ status: "accepted", orderSource: "onsite", customerName: "現場顧客", customerPhone: "現場免填" })],
		}));
		render(<MerchantView />);
		await screen.findByRole("button", { name: /製作中 1/ });
		await userEvent.click(screen.getByRole("button", { name: /製作中 1/ }));
		const card = await findOrderCard();
		expect(within(card).getByText("現場")).toBeTruthy();
		expect(card.classList.contains("source-onsite")).toBe(true);
		expect(within(card).getByText("現場").classList.contains("source-onsite")).toBe(true);
		expect(within(card).getByText("NT$ 185")).toBeTruthy();
		expect(within(card).queryByText("現場顧客")).toBeNull();
	});

	it("sorts current cards by ready deadline without showing countdown or overdue copy", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(new Date("2026-09-16T12:00:00.000Z"));
		vi.stubGlobal("fetch", createFetchMock({
			orders: [
				order({ id: "later", orderNumber: "024", estimatedReadyAt: "2026-09-16T12:15:00.000Z", customerNote: null }),
				order(),
			],
		}));
		render(<MerchantView />);
		await findOrderCard();

		const cards = screen.getAllByTestId(/^merchant-order-/);
		expect(cards.map((card) => card.getAttribute("data-testid"))).toEqual([
			"merchant-order-order-023",
			"merchant-order-later",
		]);
		expect(within(cards[0]!).getByText("19:56")).toBeTruthy();
		expect(screen.queryByText("已逾時 4 分")).toBeNull();
		expect(within(cards[1]!).getByText("20:15")).toBeTruthy();
		expect(screen.queryByText("剩 15 分")).toBeNull();
		expect(screen.queryByRole("button", { name: "下一筆" })).toBeNull();
	});

	it("loads one bounded business date at a time and keeps history rows collapsed", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(new Date("2026-10-02T04:00:00.000Z"));
		const today = getStoreBusinessDate();
		const yesterday = "2026-10-01";
		const fetchMock = createFetchMock({
			orders: [],
			historyOrdersByDate: {
				[today]: [order({ id: "today-order", orderNumber: "031", status: "completed", estimatedReadyAt: "2026-10-02T11:20:00.000Z" })],
				[yesterday]: [order({ id: "yesterday-order", orderNumber: "032", status: "rejected", estimatedReadyAt: "2026-10-01T11:20:00.000Z" })],
			},
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		await screen.findByText("目前沒有待接單");
		expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/merchant/orders/history?"))).toHaveLength(0);
		await userEvent.click(screen.getByRole("button", { name: "歷史訂單" }));
		const todayRow = await screen.findByRole("button", { name: /19:20.*已完成/ });
		expect(todayRow.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByTestId("merchant-order-today-order")).toBeNull();
		await userEvent.click(todayRow);
		expect(await screen.findByTestId("merchant-order-today-order")).toBeTruthy();
		await userEvent.click(todayRow);
		expect(screen.queryByTestId("merchant-order-today-order")).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: /日期.*2026\/10\/02/ }));
		const datePicker = screen.getByRole("dialog", { name: "選擇日期" });
		expect(within(datePicker).getAllByRole("option")).toHaveLength(90);
		expect(within(datePicker).queryByRole("option", { name: "2026/10/03" })).toBeNull();
		await userEvent.click(within(datePicker).getByRole("option", { name: "2026/10/01" }));
		const yesterdayRow = await screen.findByRole("button", { name: /19:20.*已拒單/ });
		expect(yesterdayRow.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByTestId("merchant-order-yesterday-order")).toBeNull();
		expect(screen.queryByTestId("merchant-order-today-order")).toBeNull();
		expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/merchant/orders/history?date=${today}`)).toBe(true);
		expect(fetchMock.mock.calls.some(([input]) => String(input) === `/api/merchant/orders/history?date=${yesterday}`)).toBe(true);

		await userEvent.click(screen.getByRole("button", { name: "返回工作台" }));
		expect(screen.queryByRole("heading", { name: "歷史訂單" })).toBeNull();
		expect(window.location.pathname).toBe("/merchant");
	});

	it("keeps three primary tabs and opens revenue as a secondary surface", async () => {
		vi.stubGlobal("fetch", createFetchMock());
		render(<MerchantView />);
		await findOrderCard();
		const navigation = screen.getByRole("navigation", { name: "店家主要功能" });
		expect(within(navigation).getAllByRole("button")).toHaveLength(3);
		await userEvent.click(screen.getByRole("button", { name: "營業額" }));
		expect(await screen.findByRole("heading", { name: "營業額" })).toBeTruthy();
		expect(screen.getAllByText("NT$ 185")).toHaveLength(2);
		expect(screen.getByText("依系統有效訂單計算，不代表實際現金收款。")).toBeTruthy();
		expect(window.location.pathname).toBe("/merchant/revenue");
		await userEvent.click(screen.getByRole("button", { name: "返回工作台" }));
		expect(window.location.pathname).toBe("/merchant");
	});

	it("renders an accepted Order past its deadline as history without forging completion controls", async () => {
		vi.stubGlobal("fetch", createFetchMock({
			orders: [],
			historyOrders: [order({ status: "accepted", completedAt: null })],
		}));
		render(<MerchantView />);
		await screen.findByText("目前沒有待接單");
		await userEvent.click(screen.getByRole("button", { name: "歷史訂單" }));
		const acceptedHistoryRow = await screen.findByRole("button", { name: /19:56.*已到預計取餐時間/ });
		await userEvent.click(acceptedHistoryRow);
		const historyCard = await findOrderCard();
		expect(acceptedHistoryRow.textContent).toContain("已到預計取餐時間");
		expect(within(historyCard).queryByRole("button", { name: "完成" })).toBeNull();
	});

	it("keeps 辣粉另包 as an item requirement inside the 不辣 group", async () => {
		vi.stubGlobal("fetch", createFetchMock({
			orders: [order({
				items: [{
					id: "packet-line",
					menuItemId: 4,
					name: "鹹酥雞",
					quantity: 1,
					lineTotal: 60,
					modifiers: [{ groupName: "辣度", name: "辣粉另包" }],
				}],
			})],
		}));
		render(<MerchantView />);
		const card = await findOrderCard();
		expect(within(card).getByRole("heading", { name: "不辣" })).toBeTruthy();
		expect(within(card).queryByRole("heading", { name: "辣粉另包" })).toBeNull();
		expect(within(card).getByText("辣粉另包")).toBeTruthy();
	});

	it("switches backend-authoritative busy mode and reports extended pending orders", async () => {
		const fetchMock = createFetchMock();
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		await screen.findByText("正常（至少 15 分）");
		await userEvent.click(screen.getByRole("button", { name: "切換忙碌" }));
		expect(await screen.findByText("忙碌（至少 30 分）")).toBeTruthy();
		expect(screen.getByText("已切換忙碌模式，延後 1 筆待接單")).toBeTruthy();
		const call = fetchMock.mock.calls.find(([input]) => String(input) === "/api/merchant/store/busy-mode");
		expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
			expectedBusyMode: false,
			expectedStateVersion: 1,
			busyMode: true,
		});
	});

	it("shows human-readable modifiers, distinct spice lines, and only non-null notes", async () => {
		vi.stubGlobal("fetch", createFetchMock({
			orders: [
				order(),
				order({ id: "no-note", orderNumber: "024", customerNote: null, estimatedReadyAt: "2026-09-16T12:20:00.000Z" }),
			],
		}));
		render(<MerchantView />);
		await findOrderCard();

		const noSpiceHeading = screen.getAllByRole("heading", { name: "不辣" })[0]!;
		const mediumSpiceHeading = screen.getAllByRole("heading", { name: "中辣" })[0]!;
		expect(noSpiceHeading.closest("section")?.classList.contains("spice-none")).toBe(true);
		expect(mediumSpiceHeading.closest("section")?.classList.contains("spice-medium")).toBe(true);
		expect(screen.getAllByText("切法：切").length).toBeGreaterThan(0);
		expect(screen.getAllByText("切法：不切").length).toBeGreaterThan(0);
		expect(screen.getAllByText("調味：胡椒 · 不加醬").length).toBeGreaterThan(0);
		expect(screen.getByText("雞排不要切")).toBeTruthy();
		expect(screen.getAllByText("辣／不辣分袋").length).toBeGreaterThan(0);
		const noNoteCard = getOrderCard("no-note");
		expect(noNoteCard && within(noNoteCard).queryByLabelText("訂單備註")).toBeNull();
	});

	it("exposes a disconnected state with the last sync after polling fails", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.stubGlobal("fetch", createFetchMock({ failAfterFirstPoll: true }));
		render(<MerchantView />);
		await findOrderCard();

		await vi.advanceTimersByTimeAsync(5_000);
		await screen.findByText("連線中斷");
		expect(screen.getByLabelText("連線狀態").textContent).toContain("連線中斷");
	});

	it("keeps the order pending when an order mutation fails", async () => {
		vi.stubGlobal("fetch", createFetchMock({ orderActionStatus: 403 }));
		render(<MerchantView />);
		await findOrderCard();

		const orderCard = getOrderCard();
		if (!orderCard) throw new Error("Missing order card");
		await userEvent.click(within(orderCard).getByRole("button", { name: "接單" }));

		await screen.findByText(/ORIGIN_DENIED/);
		expect(within(orderCard).getByRole("button", { name: "接單" })).toBeTruthy();
		expect(getOrderCard()).toBeTruthy();
	});

	it("shows all five pending Orders as directly actionable vertical cards", async () => {
		vi.stubGlobal("fetch", createFetchMock({
			orders: Array.from({ length: 5 }, (_, index) => order({
				id: `order-${index + 1}`,
				orderNumber: `02${index + 1}`,
				estimatedReadyAt: `2026-09-16T12:${String(10 + index).padStart(2, "0")}:00.000Z`,
			})),
		}));
		render(<MerchantView />);
		await findOrderCard("order-1");

		expect(screen.getByText("依預計完成時間排序，共 5 筆")).toBeTruthy();
		for (let index = 1; index <= 5; index += 1) {
			const card = getOrderCard(`order-${index}`);
			expect(within(card).getByRole("button", { name: "接單" })).toBeTruthy();
		}
		expect(screen.queryByRole("button", { name: "下一筆" })).toBeNull();
		expect(screen.queryByRole("button", { name: "返回待接單清單" })).toBeNull();
	});

	it("moves to production only after confirmed acceptance and reopens it by shortcut", async () => {
		const audio = installFakeAudioContext();
		const fetchMock = createFetchMock({
			orders: [
				order(),
				order({ id: "order-024", orderNumber: "024", estimatedReadyAt: "2026-09-16T12:20:00.000Z" }),
			],
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		const firstCard = await findOrderCard();
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));

		await userEvent.click(within(firstCard).getByRole("button", { name: "接單" }));
		await screen.findByText("已接單 · 預計完成 19:56");
		expect(screen.getByRole("button", { name: /製作中 1/ }).getAttribute("aria-current")).toBe("page");
		expect(screen.queryByTestId("merchant-order-order-024")).toBeNull();
		expect(screen.getByRole("button", { name: /製作中 1/ })).toBeTruthy();

		await userEvent.click(screen.getByRole("button", { name: "查看剛接的訂單" }));
		expect(screen.getByRole("button", { name: /製作中 1/ }).getAttribute("aria-current")).toBe("page");
		const acceptedCard = getOrderCard();
		expect(within(acceptedCard).getByText("雞排不要切")).toBeTruthy();
		expect(within(acceptedCard).getByRole("button", { name: "完成" })).toBeTruthy();
		expect(within(acceptedCard).queryByRole("button", { name: "拒單" })).toBeNull();
		await userEvent.click(within(acceptedCard).getByRole("button", { name: "完成" }));
		await screen.findByText("已完成 · 預計完成 19:56");
		expect(audio.starts).toHaveBeenCalledTimes(0);
	});

	it("immediately shows production when accepting the last pending Order", async () => {
		vi.stubGlobal("fetch", createFetchMock());
		render(<MerchantView />);
		const card = await findOrderCard();
		await userEvent.click(within(card).getByRole("button", { name: "接單" }));

		await screen.findByText("已接單 · 預計完成 19:56");
		expect(screen.getByRole("button", { name: /製作中 1/ }).getAttribute("aria-current")).toBe("page");
		expect(within(getOrderCard()).getByRole("button", { name: "完成" })).toBeTruthy();
	});

	it("uses an in-site reject dialog, sends nothing when cancelled, and keeps the rejected snapshot in history", async () => {
		const audio = installFakeAudioContext();
		const fetchMock = createFetchMock();
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		const card = await findOrderCard();
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));

		await userEvent.click(within(card).getByRole("button", { name: "拒單" }));
		const firstDialog = screen.getByRole("dialog", { name: "確定拒絕這筆訂單？" });
		expect(within(firstDialog).getByText("拒單後，這筆訂單將不再製作。")).toBeTruthy();
		expect(firstDialog.textContent).not.toContain("order-023");
		await userEvent.click(within(firstDialog).getByRole("button", { name: "返回" }));
		expect(fetchMock.mock.calls.filter(([input, init]) => String(input).endsWith("/reject") && init?.method === "POST")).toHaveLength(0);
		expect(getOrderCard()).toBeTruthy();

		await userEvent.click(within(await findOrderCard()).getByRole("button", { name: "拒單" }));
		await userEvent.click(within(await screen.findByRole("dialog", { name: "確定拒絕這筆訂單？" })).getByRole("button", { name: "確認拒單" }));
		await screen.findByText("已拒單 · 預計完成 19:56");
		expect(screen.queryByRole("dialog", { name: "確定拒絕這筆訂單？" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "歷史訂單" }));
		const rejectedHistoryRow = await screen.findByRole("button", { name: /19:56.*已拒單/ });
		await userEvent.click(rejectedHistoryRow);
		const historyCard = await findOrderCard();
		expect(rejectedHistoryRow.textContent).toContain("已拒單");
		expect(within(historyCard).getByText("雞排不要切")).toBeTruthy();
		expect(within(historyCard).queryByText("訂單 #023")).toBeNull();
		expect(within(historyCard).queryByText("王小明")).toBeNull();
		expect(within(historyCard).queryByText("0912345678")).toBeNull();
		expect(audio.starts).toHaveBeenCalledTimes(0);
	});

	it("reloads the authoritative status after a 409 and leaves the pending Order actionable", async () => {
		const fetchMock = createFetchMock({ orderActionStatus: 409 });
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		const card = await findOrderCard();

		await userEvent.click(within(card).getByRole("button", { name: "接單" }));
		await screen.findByText("預計完成 19:56 的訂單已被其他裝置更新，已重新同步最新狀態。");
		expect(within(getOrderCard()).getByRole("button", { name: "接單" })).toBeTruthy();
		expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/merchant/orders").length).toBeGreaterThan(1);
	});

	it("keeps existing cards visible while polling discovers a newer Order", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const first = order();
		const second = order({ id: "order-024", orderNumber: "024", estimatedReadyAt: "2026-09-16T12:20:00.000Z" });
		const incoming = order({ id: "order-020", orderNumber: "020", estimatedReadyAt: "2026-09-16T11:50:00.000Z" });
		vi.stubGlobal("fetch", createFetchMock({ orderPollSequence: [[first, second], [incoming, first, second]] }));
		render(<MerchantView />);
		await findOrderCard();

		await vi.advanceTimersByTimeAsync(10_100);
		expect(getOrderCard()).toBeTruthy();
		expect(screen.getByRole("button", { name: /待接單 3/ })).toBeTruthy();
	});

	it("returns an empty preparing view to pending when polling receives the next Order", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const preparing = order({ id: "preparing", status: "accepted" });
		const incoming = order({ id: "incoming", status: "pending" });
		vi.stubGlobal("fetch", createFetchMock({ orderPollSequence: [[preparing], [incoming]] }));
		render(<MerchantView />);
		await screen.findByRole("button", { name: /製作中 1/ });
		await userEvent.click(screen.getByRole("button", { name: /製作中 1/ }));
		expect(screen.getByRole("button", { name: /製作中 1/ }).getAttribute("aria-current")).toBe("page");

		await vi.advanceTimersByTimeAsync(5_100);
		await screen.findByTestId("merchant-order-incoming");
		expect(screen.getByRole("button", { name: /待接單 1/ }).getAttribute("aria-current")).toBe("page");
	});

	it("labels a deadline-expired preparing Order as auto-closed instead of another-device activity", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(new Date("2026-09-16T12:00:00.000Z"));
		const expired = order({
			id: "expired-preparing",
			status: "accepted",
			estimatedReadyAt: "2026-09-16T11:56:00.000Z",
		});
		vi.stubGlobal("fetch", createFetchMock({ orderPollSequence: [[expired], []] }));
		render(<MerchantView />);
		await screen.findByRole("button", { name: /製作中 1/ });
		await userEvent.click(screen.getByRole("button", { name: /製作中 1/ }));

		await vi.advanceTimersByTimeAsync(5_100);
		expect(await screen.findByText("預計完成 19:56 已到，自動移出製作中。")).toBeTruthy();
		expect(screen.queryByText(/其他裝置更新/)).toBeNull();
		await waitFor(() => expect(screen.getByRole("button", { name: /待接單 0/ }).getAttribute("aria-current")).toBe("page"));
	});

	it("a genuinely new pending Order interrupts production once, not on repeated polls", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const preparing = order({ id: "preparing", status: "accepted" });
		const incoming = order({ id: "incoming", status: "pending" });
		vi.stubGlobal("fetch", createFetchMock({ orderPollSequence: [[preparing], [preparing, incoming]] }));
		render(<MerchantView />);
		await screen.findByRole("button", { name: /製作中 1/ });
		await userEvent.click(screen.getByRole("button", { name: /製作中 1/ }));

		await vi.advanceTimersByTimeAsync(10_100);
		expect(await screen.findByRole("button", { name: /待接單 1/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /待接單 1/ }).getAttribute("aria-current")).toBe("page");
		expect(screen.getByTestId("merchant-order-incoming")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: /製作中 1/ }));
		await vi.advanceTimersByTimeAsync(10_100);
		expect(screen.getByRole("button", { name: /製作中 1/ }).getAttribute("aria-current")).toBe("page");
	});

	it("T-10 interrupts sold-out once, while unchanged polls leave manual focus alone", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
		const preparing = order({ id: "deadline", status: "accepted", estimatedReadyAt: "2026-10-07T10:11:00Z" });
		vi.stubGlobal("fetch", createFetchMock({ orders: [order(), preparing] }));
		render(<MerchantView />); await findOrderCard();
		await userEvent.click(screen.getByRole("button", { name: "售罄" }));
		await vi.advanceTimersByTimeAsync(61_000);
		await waitFor(() => expect(screen.getByRole("button", { name: /製作中 1/ }).getAttribute("aria-current")).toBe("page"));
		expect(screen.getByTestId("merchant-order-deadline")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "售罄" }));
		await vi.advanceTimersByTimeAsync(10_100);
		expect(screen.getByRole("button", { name: "售罄" }).getAttribute("aria-current")).toBe("page");
	});

	it("new pending wins over T-10 in the same authoritative snapshot", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
		const preparing = order({ id: "deadline", status: "accepted", estimatedReadyAt: "2026-10-07T10:11:00Z" });
		const incoming = order({ id: "priority-new" });
		vi.stubGlobal("fetch", createFetchMock({ orderPollSequence: [[order(), preparing], [order(), { ...preparing, estimatedReadyAt: "2026-10-07T10:09:00Z" }, incoming]] }));
		render(<MerchantView />); await findOrderCard();
		await userEvent.click(screen.getByRole("button", { name: "售罄" }));
		await vi.advanceTimersByTimeAsync(5_100);
		await screen.findByTestId("merchant-order-priority-new");
		expect(screen.getByRole("button", { name: /待接單 2/ }).getAttribute("aria-current")).toBe("page");
		await userEvent.click(screen.getByRole("button", { name: "售罄" }));
		await vi.advanceTimersByTimeAsync(10_100);
		expect(screen.getByRole("button", { name: "售罄" }).getAttribute("aria-current")).toBe("page");
	});

	it("an empty-queue fallback never pulls the operator out of sold-out", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.stubGlobal("fetch", createFetchMock({ orders: [] }));
		render(<MerchantView />); await screen.findByText("目前沒有待接單");
		await userEvent.click(screen.getByRole("button", { name: "售罄" }));
		await vi.advanceTimersByTimeAsync(10_100);
		expect(screen.getByRole("button", { name: "售罄" }).getAttribute("aria-current")).toBe("page");
	});

	it("resume and notification clicks synchronize without making business mutations", async () => {
		const worker = new EventTarget();
		Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
		const fetchMock = createFetchMock({ orders: [order(), order({ id: "accepted", status: "accepted" })] });
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />); await findOrderCard();
		await userEvent.click(screen.getByRole("button", { name: "售罄" }));
		const before = fetchMock.mock.calls.filter(([input]) => input === "/api/merchant/orders").length;
		window.dispatchEvent(new Event("pageshow"));
		await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => input === "/api/merchant/orders").length).toBeGreaterThan(before));
		expect(screen.getByRole("button", { name: "售罄" }).getAttribute("aria-current")).toBe("page");
		worker.dispatchEvent(new MessageEvent("message", { data: { type: "MERCHANT_NOTIFICATION_OPEN" } }));
		await waitFor(() => expect(screen.getByRole("button", { name: /待接單 1/ }).getAttribute("aria-current")).toBe("page"));
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
	});

	it("discards a delayed pre-accept poll rather than reverting the confirmed order or focus", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const base = createFetchMock();
		let polls = 0;
		let resolve!: (response: Response) => void;
		vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			if (input === "/api/merchant/orders" && ++polls === 2) return new Promise<Response>((done) => { resolve = done; });
			return base(input, init);
		}));
		render(<MerchantView />); await findOrderCard();
		await vi.advanceTimersByTimeAsync(5_100);
		await userEvent.click(within(getOrderCard()).getByRole("button", { name: "接單" }));
		await screen.findByText("已接單 · 預計完成 19:56");
		resolve(await json({ orders: [order()] }));
		await vi.advanceTimersByTimeAsync(100);
		expect(screen.getByRole("button", { name: /製作中 1/ }).getAttribute("aria-current")).toBe("page");
		expect(within(getOrderCard()).getByRole("button", { name: "完成" })).toBeTruthy();
		expect(within(getOrderCard()).queryByRole("button", { name: "接單" })).toBeNull();
	});

	it.each([403, 409, 422, 500])("accept HTTP %s never pretends to navigate to production", async (status) => {
		vi.stubGlobal("fetch", createFetchMock({ orderActionStatus: status }));
		render(<MerchantView />); await findOrderCard();
		await userEvent.click(within(getOrderCard()).getByRole("button", { name: "接單" }));
		await waitFor(() => expect(within(getOrderCard()).getByRole("button", { name: "接單" }).hasAttribute("disabled")).toBe(false));
		expect(screen.getByRole("button", { name: /待接單 1/ }).getAttribute("aria-current")).toBe("page");
		expect(screen.queryByText(/^已接單 ·/)).toBeNull();
	});

	it("a network error reconciles but does not navigate while authoritative state remains pending", async () => {
		const base = createFetchMock();
		vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/accept")) throw new TypeError("connection lost");
			return base(input, init);
		}));
		render(<MerchantView />); await findOrderCard();
		await userEvent.click(within(getOrderCard()).getByRole("button", { name: "接單" }));
		await screen.findByText(/操作結果尚未確認/);
		expect(screen.getByRole("button", { name: /待接單 1/ }).getAttribute("aria-current")).toBe("page");
		expect(within(getOrderCard()).getByRole("button", { name: "接單" })).toBeTruthy();
		expect(base.mock.calls.filter(([input]) => String(input).endsWith("/accept"))).toHaveLength(0);
	});

	it("reject leaves the ring running until the last alerted pending Order is confirmed rejected", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		installFakeAudioContext();
		const old = order({ id: "old" });
		const first = order({ id: "reject-one" });
		const second = order({ id: "reject-two" });
		const base = createFetchMock({ orders: [old, first, second] });
		let polls = 0;
		vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			if (input === "/api/merchant/orders" && ++polls === 1) return json({ orders: [old] });
			return base(input, init);
		}));
		render(<MerchantView />); await findOrderCard("old");
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));
		await vi.advanceTimersByTimeAsync(5_100);
		await screen.findByRole("button", { name: /停止提示音/ });
		for (const id of ["reject-one", "reject-two"]) {
			await userEvent.click(within(await findOrderCard(id)).getByRole("button", { name: "拒單" }));
			await userEvent.click(within(await screen.findByRole("dialog", { name: "確定拒絕這筆訂單？" })).getByRole("button", { name: "確認拒單" }));
			await waitFor(() => expect(screen.queryByTestId(`merchant-order-${id}`)).toBeNull());
			if (id === "reject-one") expect(screen.getByRole("button", { name: /停止提示音/ })).toBeTruthy();
		}
		expect(screen.queryByRole("button", { name: /停止提示音/ })).toBeNull();
		expect(getOrderCard("old")).toBeTruthy();
	});

	it("targets the selected spice line for shortage and refreshes the shared Menu Item as sold out", async () => {
		const fetchMock = createFetchMock();
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		const card = await findOrderCard();
		const mediumGroup = within(card).getByRole("heading", { name: "中辣" }).closest("section");
		if (!mediumGroup) throw new Error("Missing medium-spice group");
		await userEvent.click(within(mediumGroup).getByRole("button", { name: "缺貨" }));
		const dialog = screen.getByRole("dialog", { name: "確認品項缺貨？" });
		expect(within(dialog).getByText(/香雞排/)).toBeTruthy();
		expect(within(dialog).queryByRole("combobox")).toBeNull();
		await userEvent.click(within(dialog).getByRole("button", { name: "確認缺貨並停售" }));
		await screen.findByText(/香雞排已停售/);

		const shortageCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/shortages"));
		expect(JSON.parse(String(shortageCall?.[1]?.body)).items).toEqual([
			{ orderItemId: "line-chicken-medium", quantity: 1 },
		]);
		await userEvent.click(within(screen.getByRole("navigation", { name: "店家主要功能" })).getByRole("button", { name: "售罄" }));
		expect(await screen.findByRole("button", { name: "恢復 香雞排" })).toBeTruthy();
	});

	it("persists large-text mode and keeps a long note visible", async () => {
		const longNote = "這是一段很長的訂單備註，請炸酥一點並確認每一項調味與切法都完整顯示，不可以截斷。";
		vi.stubGlobal("fetch", createFetchMock({ orders: [order({ customerNote: longNote })] }));
		render(<MerchantView />);
		await screen.findByText(longNote);

		await userEvent.click(screen.getByRole("button", { name: "大字模式" }));
		expect(document.querySelector(".merchant-page.large-text")).toBeTruthy();
		expect(localStorage.getItem("merchant-large-text")).toBe("true");
		expect(screen.getByText(longNote)).toBeTruthy();
	});

	it("lists products and uses only the narrow sold-out and restore endpoints", async () => {
		const audio = installFakeAudioContext();
		const fetchMock = createFetchMock();
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		await findOrderCard();
		await userEvent.click(screen.getByRole("button", { name: /字模式/ }));
		const navigation = screen.getByRole("navigation", { name: "店家主要功能" });
		await userEvent.click(within(navigation).getByRole("button", { name: "售罄" }));

		expect(screen.getByText("香雞排")).toBeTruthy();
		expect(screen.getByText("青椒")).toBeTruthy();
		const soldOutRow = screen.getByRole("button", { name: "恢復 青椒" }).closest("li");
		expect(soldOutRow?.classList.contains("is-sold-out")).toBe(true);
		await userEvent.click(screen.getByRole("button", { name: "售罄 香雞排" }));
		const restoreChicken = await screen.findByRole("button", { name: "恢復 香雞排" });
		expect(restoreChicken.closest("li")?.classList.contains("is-sold-out")).toBe(true);
		await userEvent.click(screen.getByRole("button", { name: "恢復 香雞排" }));
		const sellOutChicken = await screen.findByRole("button", { name: "售罄 香雞排" });
		expect(sellOutChicken.closest("li")?.classList.contains("is-sold-out")).toBe(false);

		const postedUrls = fetchMock.mock.calls
			.filter(([, init]) => init?.method === "POST")
			.map(([input]) => String(input));
		expect(postedUrls).toEqual([
			"/api/merchant/menu-items/1/sold-out",
			"/api/merchant/menu-items/1/restore",
		]);
		expect(document.querySelector("input[name='price']")).toBeNull();
		expect(audio.starts).toHaveBeenCalledTimes(0);
	});

	it("automatically lists a newly created active product and uses its quick-sold-out metadata", async () => {
		const fetchMock = createFetchMock();
		const originalImplementation = fetchMock.getMockImplementation();
		fetchMock.mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? (input instanceof Request ? input.method : "GET");
			if (url === "/api/menu" && method === "GET") {
				return json({
					categories: [{
						id: 1,
						name: "炸物",
						items: [
							{ id: 1, name: "香雞排", isAvailable: true, isQuickSoldOut: true },
							{ id: 2, name: "青椒", isAvailable: false, isQuickSoldOut: false },
							{ id: 3, name: "新品雞塊", isAvailable: true, isQuickSoldOut: true },
						],
					}],
				});
			}
			if (!originalImplementation) throw new Error("Missing base fetch implementation");
			return originalImplementation(input, init);
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<MerchantView />);
		await findOrderCard();
		await userEvent.click(within(screen.getByRole("navigation", { name: "店家主要功能" })).getByRole("button", { name: "售罄" }));

		const quickSection = screen.getByRole("heading", { name: "快速售罄" }).closest("section");
		if (!quickSection) throw new Error("Missing quick-sold-out section");
		expect(within(quickSection).getByText("香雞排")).toBeTruthy();
		expect(within(quickSection).getByText("新品雞塊")).toBeTruthy();
		expect(within(quickSection).queryByText("青椒")).toBeNull();
		expect(screen.getAllByText("新品雞塊")).toHaveLength(2);
	});
});
