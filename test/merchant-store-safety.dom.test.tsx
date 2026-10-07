import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MerchantView from "../src/react-app/MerchantView";

type StoreState = {
	display_name: string;
	is_accepting_orders: boolean;
	stateVersion: number;
};

type MockOptions = {
	store?: StoreState;
	orders?: Array<Record<string, unknown>>;
};

function json(value: unknown, status = 200) {
	return Promise.resolve(
		new Response(JSON.stringify(value), {
			status,
			headers: { "content-type": "application/json" },
		}),
	);
}

function requestUrl(input: RequestInfo | URL) {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit) {
	return init?.method ?? (input instanceof Request ? input.method : "GET");
}

function createFetchMock(options: MockOptions = {}) {
	let store =
		options.store ??
		({
			display_name: "吃炸的",
			is_accepting_orders: false,
			stateVersion: 0,
		} satisfies StoreState);
	let orders = options.orders ?? [];
	const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		const method = requestMethod(input, init);
		if (url === "/api/merchant/orders" && method === "GET") return json({ orders });
		if (url === "/api/merchant/notifications" && method === "GET") {
			return json({ deliveries: [] });
		}
		if (url === "/api/menu" && method === "GET") return json({ categories: [] });
		if (url === "/api/store" && method === "GET") return json(store);
		if (url.includes("/api/merchant/orders/") && method === "POST") {
			const current = orders.find((order) => url.includes(`/orders/${order.id}/`));
			orders = [];
			return json({ order: { ...current, status: "rejected" } });
		}
		if (url === "/api/merchant/store/resume" && method === "POST") {
			const body = JSON.parse(String(init?.body)) as { operationId: string };
			store = { ...store, is_accepting_orders: true, stateVersion: store.stateVersion + 1 };
			return json({
				operationId: body.operationId,
				action: "resume",
				outcome: "APPLIED",
				operation: {
					outcome: "APPLIED",
					store: { is_accepting_orders: true },
					stateVersion: store.stateVersion,
					createdAt: "2026-09-14T01:00:00.000Z",
				},
				store: { is_accepting_orders: true },
				stateVersion: store.stateVersion,
				createdAt: "2026-09-14T01:00:00.000Z",
			});
		}
		if (url === "/api/merchant/store/pause" && method === "POST") {
			const body = JSON.parse(String(init?.body)) as { operationId: string };
			store = { ...store, is_accepting_orders: false, stateVersion: store.stateVersion + 1 };
			return json({
				operationId: body.operationId,
				action: "pause",
				outcome: "APPLIED",
				operation: {
					outcome: "APPLIED",
					store: { is_accepting_orders: false },
					stateVersion: store.stateVersion,
					createdAt: "2026-09-14T01:00:00.000Z",
				},
				store: { is_accepting_orders: false },
				stateVersion: store.stateVersion,
				createdAt: "2026-09-14T01:00:00.000Z",
			});
		}
		throw new Error(`Unexpected request: ${method} ${url}`);
	});
	return { mock, getStore: () => store, setStore: (value: StoreState) => (store = value) };
}

function button(selector: string) {
	const element = document.querySelector<HTMLButtonElement>(selector);
	if (!element) throw new Error(`Missing button ${selector}`);
	return element;
}

function callsTo(mock: ReturnType<typeof vi.fn>, url: string, method: string) {
	return mock.mock.calls.filter(
		([input, init]) => requestUrl(input as RequestInfo | URL) === url && requestMethod(input as RequestInfo | URL, init as RequestInit) === method,
	);
}

beforeEach(() => {
	vi.stubGlobal("confirm", vi.fn(() => true));
	Object.defineProperty(globalThis.crypto, "randomUUID", {
		configurable: true,
		value: vi.fn(() => "20000000-0000-4000-8000-000000000001"),
	});
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Merchant Store safety DOM", () => {
	it("reads fresh Store state before Resume and cancellation never posts", async () => {
		const { mock } = createFetchMock();
		vi.stubGlobal("fetch", mock);
		vi.mocked(confirm).mockReturnValue(false);
		render(<MerchantView />);
		const control = await screen.findByTestId("store-control");
		expect(control.classList.contains("paused")).toBe(true);
		expect(screen.getByRole("button", { name: "恢復接單" })).toBeTruthy();
		const readsBefore = callsTo(mock, "/api/store", "GET").length;

		await userEvent.click(button(".resume-store-button"));

		await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
		expect(String(vi.mocked(confirm).mock.calls[0][0])).toContain("即將公開接受真人訂單");
		expect(callsTo(mock, "/api/store", "GET")).toHaveLength(readsBefore + 1);
		expect(callsTo(mock, "/api/merchant/store/resume", "POST")).toHaveLength(0);
		expect(crypto.randomUUID).not.toHaveBeenCalled();
	});

	it("confirms Resume once and a synchronous double click creates one operation", async () => {
		const { mock } = createFetchMock();
		vi.stubGlobal("fetch", mock);
		render(<MerchantView />);
		await screen.findByTestId("store-control");
		const resume = button(".resume-store-button");

		fireEvent.click(resume);
		fireEvent.click(resume);

		await waitFor(() =>
			expect(callsTo(mock, "/api/merchant/store/resume", "POST")).toHaveLength(1),
		);
		expect(confirm).toHaveBeenCalledOnce();
		expect(crypto.randomUUID).toHaveBeenCalledOnce();
		await waitFor(() => expect(button(".pause-store-button").disabled).toBe(false));
	});

	it("pauses without confirmation and never selects the Resume endpoint", async () => {
		const { mock } = createFetchMock({
			store: { display_name: "吃炸的", is_accepting_orders: true, stateVersion: 4 },
		});
		vi.stubGlobal("fetch", mock);
		render(<MerchantView />);
		await screen.findByTestId("store-control");

		await userEvent.click(button(".pause-store-button"));

		await waitFor(() =>
			expect(callsTo(mock, "/api/merchant/store/pause", "POST")).toHaveLength(1),
		);
		expect(callsTo(mock, "/api/merchant/store/resume", "POST")).toHaveLength(0);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("uses the same operationId for one safe Pause replay after an ambiguous response", async () => {
		const operation = "20000000-0000-4000-8000-000000000009";
		vi.mocked(crypto.randomUUID).mockReturnValue(operation);
		let store: StoreState = {
			display_name: "吃炸的",
			is_accepting_orders: true,
			stateVersion: 9,
		};
		let pauseAttempts = 0;
		const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = requestUrl(input);
			const method = requestMethod(input, init);
			if (url === "/api/merchant/orders") return json({ orders: [] });
			if (url === "/api/merchant/notifications") return json({ deliveries: [] });
			if (url === "/api/menu") return json({ categories: [] });
			if (url === "/api/store") return json(store);
			if (url === `/api/merchant/store/operations/${operation}`) return json({}, 404);
			if (url === "/api/merchant/store/pause" && method === "POST") {
				pauseAttempts += 1;
				if (pauseAttempts === 1) throw new TypeError("connection interrupted");
				store = { ...store, is_accepting_orders: false, stateVersion: 10 };
				return json({
					operationId: operation,
					action: "pause",
					outcome: "APPLIED",
					operation: {
						outcome: "APPLIED",
						store: { is_accepting_orders: false },
						stateVersion: 10,
						createdAt: "2026-09-14T01:00:00.000Z",
					},
					store: { is_accepting_orders: false },
					stateVersion: 10,
					createdAt: "2026-09-14T01:00:00.000Z",
				});
			}
			throw new Error(`Unexpected request: ${method} ${url}`);
		});
		vi.stubGlobal("fetch", mock);
		render(<MerchantView />);
		await screen.findByTestId("store-control");

		await userEvent.click(button(".pause-store-button"));

		await waitFor(() => expect(callsTo(mock, "/api/merchant/store/pause", "POST")).toHaveLength(2));
		const bodies = callsTo(mock, "/api/merchant/store/pause", "POST").map(([, init]) =>
			JSON.parse(String((init as RequestInit).body)),
		);
		expect(bodies).toEqual([
			{ operationId: operation, expectedIsAcceptingOrders: true, expectedStateVersion: 9 },
			{ operationId: operation, expectedIsAcceptingOrders: true, expectedStateVersion: 9 },
		]);
		expect(crypto.randomUUID).toHaveBeenCalledOnce();
	});

	it("accepts an existing ambiguous Pause operation only after the Store is authoritatively paused", async () => {
		const operation = "20000000-0000-4000-8000-000000000010";
		vi.mocked(crypto.randomUUID).mockReturnValue(operation);
		let store: StoreState = {
			display_name: "吃炸的",
			is_accepting_orders: true,
			stateVersion: 10,
		};
		const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = requestUrl(input);
			const method = requestMethod(input, init);
			if (url === "/api/merchant/orders") return json({ orders: [] });
			if (url === "/api/merchant/notifications") return json({ deliveries: [] });
			if (url === "/api/menu") return json({ categories: [] });
			if (url === "/api/store") return json(store);
			if (url === `/api/merchant/store/operations/${operation}`) {
				store = { ...store, is_accepting_orders: false, stateVersion: 11 };
				return json({
					operationId: operation,
					action: "pause",
					outcome: "IDEMPOTENT_REPLAY",
					operation: {
						outcome: "APPLIED",
						store: { is_accepting_orders: false },
						stateVersion: 11,
						createdAt: "2026-09-14T01:00:00.000Z",
					},
					store: { is_accepting_orders: false },
					stateVersion: 11,
					createdAt: "2026-09-14T01:00:00.000Z",
				});
			}
			if (url === "/api/merchant/store/pause" && method === "POST") {
				throw new TypeError("connection interrupted");
			}
			throw new Error(`Unexpected request: ${method} ${url}`);
		});
		vi.stubGlobal("fetch", mock);
		render(<MerchantView />);
		await screen.findByTestId("store-control");

		await userEvent.click(button(".pause-store-button"));

		await waitFor(() => expect(button(".resume-store-button").disabled).toBe(false));
		expect(callsTo(mock, "/api/merchant/store/pause", "POST")).toHaveLength(1);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(crypto.randomUUID).toHaveBeenCalledOnce();
	});

	it("does not trust an existing Pause operation when the Store is currently accepting", async () => {
		const operation = "20000000-0000-4000-8000-000000000011";
		vi.mocked(crypto.randomUUID).mockReturnValue(operation);
		const store: StoreState = {
			display_name: "吃炸的",
			is_accepting_orders: true,
			stateVersion: 12,
		};
		const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = requestUrl(input);
			const method = requestMethod(input, init);
			if (url === "/api/merchant/orders") return json({ orders: [] });
			if (url === "/api/merchant/notifications") return json({ deliveries: [] });
			if (url === "/api/menu") return json({ categories: [] });
			if (url === "/api/store") return json(store);
			if (url === `/api/merchant/store/operations/${operation}`) {
				return json({
					operationId: operation,
					action: "pause",
					outcome: "IDEMPOTENT_REPLAY",
					operation: {
						outcome: "APPLIED",
						store: { is_accepting_orders: false },
						stateVersion: 11,
						createdAt: "2026-09-14T01:00:00.000Z",
					},
					store: { is_accepting_orders: true },
					stateVersion: 12,
					createdAt: "2026-09-14T01:00:00.000Z",
				});
			}
			if (url === "/api/merchant/store/pause" && method === "POST") {
				throw new TypeError("connection interrupted");
			}
			throw new Error(`Unexpected request: ${method} ${url}`);
		});
		vi.stubGlobal("fetch", mock);
		render(<MerchantView />);
		await screen.findByTestId("store-control");

		await userEvent.click(button(".pause-store-button"));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("緊急");
		expect(callsTo(mock, "/api/merchant/store/pause", "POST")).toHaveLength(1);
		expect(button(".pause-store-button").disabled).toBe(false);
		expect(crypto.randomUUID).toHaveBeenCalledOnce();
	});

	it("reports a high-priority error when the one allowed Pause replay still leaves the Store accepting", async () => {
		const operation = "20000000-0000-4000-8000-000000000012";
		vi.mocked(crypto.randomUUID).mockReturnValue(operation);
		const store: StoreState = {
			display_name: "吃炸的",
			is_accepting_orders: true,
			stateVersion: 12,
		};
		let pauseAttempts = 0;
		const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = requestUrl(input);
			const method = requestMethod(input, init);
			if (url === "/api/merchant/orders") return json({ orders: [] });
			if (url === "/api/merchant/notifications") return json({ deliveries: [] });
			if (url === "/api/menu") return json({ categories: [] });
			if (url === "/api/store") return json(store);
			if (url === `/api/merchant/store/operations/${operation}`) return json({}, 404);
			if (url === "/api/merchant/store/pause" && method === "POST") {
				pauseAttempts += 1;
				if (pauseAttempts === 1) throw new TypeError("connection interrupted");
				return json({
					operationId: operation,
					action: "pause",
					outcome: "IDEMPOTENT_REPLAY",
					operation: {
						outcome: "APPLIED",
						store: { is_accepting_orders: false },
						stateVersion: 11,
						createdAt: "2026-09-14T01:00:00.000Z",
					},
					store: { is_accepting_orders: true },
					stateVersion: 12,
					createdAt: "2026-09-14T01:00:00.000Z",
				});
			}
			throw new Error(`Unexpected request: ${method} ${url}`);
		});
		vi.stubGlobal("fetch", mock);
		render(<MerchantView />);
		await screen.findByTestId("store-control");

		await userEvent.click(button(".pause-store-button"));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("緊急");
		const posts = callsTo(mock, "/api/merchant/store/pause", "POST");
		expect(posts).toHaveLength(2);
		expect(posts.map(([, init]) => JSON.parse(String((init as RequestInit).body)).operationId)).toEqual([
			operation,
			operation,
		]);
		expect(crypto.randomUUID).toHaveBeenCalledOnce();
	});

	it("does not replay Pause after a conclusive access denial", async () => {
		const { mock: baseMock } = createFetchMock({
			store: { display_name: "吃炸的", is_accepting_orders: true, stateVersion: 5 },
		});
		const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (
				requestUrl(input) === "/api/merchant/store/pause" &&
				requestMethod(input, init) === "POST"
			) {
				return json({ error: { code: "AUTH_DENIED" } }, 403);
			}
			return baseMock(input, init);
		});
		vi.stubGlobal("fetch", mock);
		render(<MerchantView />);
		await screen.findByTestId("store-control");

		await userEvent.click(button(".pause-store-button"));

		await screen.findByRole("alert");
		expect(callsTo(mock, "/api/merchant/store/pause", "POST")).toHaveLength(1);
		expect(
			mock.mock.calls.some(([input]) => requestUrl(input as RequestInfo | URL).includes("/operations/")),
		).toBe(false);
	});

	it("keeps Store controls stable when Reject removes an Order", async () => {
		const order = {
			id: "order-one",
			orderNumber: "CZ-TEST",
			status: "pending",
			total: 20,
			estimatedReadyAt: "2026-09-14T01:15:00.000Z",
			createdAt: "2026-09-14T01:00:00.000Z",
			customerName: "Test",
			customerPhone: "test-marker",
			customerNote: "辣粉另包",
			specialOrder: false,
			items: [{ name: "Item", quantity: 1, lineTotal: 20, modifiers: [] }],
		};
		const { mock } = createFetchMock({ orders: [order] });
		vi.stubGlobal("fetch", mock);
		render(<MerchantView />);
		const controlBefore = await screen.findByTestId("store-control");
		const resumeBefore = button(".resume-store-button");
		const reject = button(".reject-button");
		expect(screen.getByText("訂單備註")).toBeTruthy();
		expect(screen.getByText("辣粉另包")).toBeTruthy();

		await userEvent.click(reject);
		await userEvent.click(screen.getByRole("button", { name: "確認拒單" }));

		await waitFor(() => expect(document.querySelector(".reject-button")).toBeNull());
		expect(screen.getByTestId("store-control")).toBe(controlBefore);
		expect(button(".resume-store-button")).toBe(resumeBefore);
		expect(callsTo(mock, "/api/merchant/store/resume", "POST")).toHaveLength(0);
	});

	it("does not let an older in-flight poll overwrite a newer Store mutation", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let storeCalls = 0;
		let resolveOldPoll: ((response: Response) => void) | undefined;
		let current: StoreState = {
			display_name: "吃炸的",
			is_accepting_orders: true,
			stateVersion: 2,
		};
		const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = requestUrl(input);
			const method = requestMethod(input, init);
			if (url === "/api/merchant/orders") return json({ orders: [] });
			if (url === "/api/merchant/notifications") return json({ deliveries: [] });
			if (url === "/api/menu") return json({ categories: [] });
			if (url === "/api/store") {
				storeCalls += 1;
				if (storeCalls === 2) {
					return new Promise<Response>((resolve) => {
						resolveOldPoll = resolve;
					});
				}
				return json(current);
			}
			if (url === "/api/merchant/store/pause" && method === "POST") {
				const body = JSON.parse(String(init?.body)) as { operationId: string };
				current = { ...current, is_accepting_orders: false, stateVersion: 3 };
				return json({
					operationId: body.operationId,
					action: "pause",
					outcome: "APPLIED",
					operation: {
						outcome: "APPLIED",
						store: { is_accepting_orders: false },
						stateVersion: 3,
						createdAt: "2026-09-14T01:00:00.000Z",
					},
					store: { is_accepting_orders: false },
					stateVersion: 3,
					createdAt: "2026-09-14T01:00:00.000Z",
				});
			}
			throw new Error(`Unexpected request: ${method} ${url}`);
		});
		vi.stubGlobal("fetch", mock);
		render(<MerchantView />);
		await screen.findByTestId("store-control");

		await vi.advanceTimersByTimeAsync(5_000);
		await waitFor(() => expect(resolveOldPoll).toBeTypeOf("function"));
		await userEvent.click(button(".pause-store-button"), { advanceTimers: vi.advanceTimersByTime });
		await waitFor(() => expect(button(".resume-store-button").disabled).toBe(false));
		resolveOldPoll?.(
			new Response(
				JSON.stringify({
					display_name: "吃炸的",
					is_accepting_orders: true,
					stateVersion: 2,
				}),
			),
		);
		await Promise.resolve();

		expect(button(".pause-store-button").disabled).toBe(true);
		expect(button(".resume-store-button").disabled).toBe(false);
		expect(document.querySelector(".store-sync-status")?.textContent).toContain("3");
	});

	it("does not let a stale poll update Last Sync, restore access health, or clear a Store error", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(new Date("2026-09-14T01:00:00.000Z"));
		let storeCalls = 0;
		let resolveOldPoll: ((response: Response) => void) | undefined;
		const store: StoreState = {
			display_name: "吃炸的",
			is_accepting_orders: false,
			stateVersion: 3,
		};
		const mock = vi.fn(async (input: RequestInfo | URL) => {
			const url = requestUrl(input);
			if (url === "/api/merchant/orders") return json({ orders: [] });
			if (url === "/api/merchant/notifications") return json({ deliveries: [] });
			if (url === "/api/menu") return json({ categories: [] });
			if (url === "/api/store") {
				storeCalls += 1;
				if (storeCalls === 2) {
					return new Promise<Response>((resolve) => {
						resolveOldPoll = resolve;
					});
				}
				if (storeCalls === 3) return json({ error: "unavailable" }, 503);
				return json(store);
			}
			throw new Error(`Unexpected request: GET ${url}`);
		});
		vi.stubGlobal("fetch", mock);
		render(<MerchantView />);
		await screen.findByTestId("store-control");
		await waitFor(() => expect(button(".resume-store-button").disabled).toBe(false));

		await vi.advanceTimersByTimeAsync(5_000);
		await waitFor(() => expect(resolveOldPoll).toBeTypeOf("function"));
		await userEvent.click(button(".resume-store-button"), {
			advanceTimers: vi.advanceTimersByTime,
		});
		const errorBefore = (await screen.findByRole("alert")).textContent;
		const syncBefore = document.querySelector(".store-sync-status")?.textContent;
		expect(button(".resume-store-button").disabled).toBe(true);

		vi.setSystemTime(new Date("2026-09-14T02:00:00.000Z"));
		resolveOldPoll?.(
			new Response(JSON.stringify(store), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await Promise.resolve();
		await Promise.resolve();

		expect(screen.getByRole("alert").textContent).toBe(errorBefore);
		expect(document.querySelector(".store-sync-status")?.textContent).toBe(syncBefore);
		expect(button(".resume-store-button").disabled).toBe(true);
		expect(callsTo(mock, "/api/merchant/store/resume", "POST")).toHaveLength(0);
	});

	it("disables Resume after a Merchant access polling failure", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		let orderReads = 0;
		const { mock: baseMock } = createFetchMock();
		const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (requestUrl(input) === "/api/merchant/orders") {
				orderReads += 1;
				if (orderReads > 1) return json({ error: { code: "AUTH_DENIED" } }, 403);
			}
			return baseMock(input, init);
		});
		vi.stubGlobal("fetch", mock);
		render(<MerchantView />);
		await screen.findByTestId("store-control");
		await waitFor(() => expect(button(".resume-store-button").disabled).toBe(false));

		await vi.advanceTimersByTimeAsync(5_000);

		await waitFor(() => expect(button(".resume-store-button").disabled).toBe(true));
		expect(callsTo(mock, "/api/merchant/store/resume", "POST")).toHaveLength(0);
	});

	it("fails closed when the fresh Store read before Resume fails", async () => {
		let storeReads = 0;
		const { mock: baseMock } = createFetchMock();
		const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (requestUrl(input) === "/api/store") {
				storeReads += 1;
				if (storeReads > 1) return json({ error: "unavailable" }, 503);
			}
			return baseMock(input, init);
		});
		vi.stubGlobal("fetch", mock);
		render(<MerchantView />);
		await screen.findByTestId("store-control");
		await waitFor(() => expect(button(".resume-store-button").disabled).toBe(false));

		await userEvent.click(button(".resume-store-button"));

		await waitFor(() => expect(button(".resume-store-button").disabled).toBe(true));
		expect(confirm).not.toHaveBeenCalled();
		expect(callsTo(mock, "/api/merchant/store/resume", "POST")).toHaveLength(0);
		expect(crypto.randomUUID).not.toHaveBeenCalled();
	});
});
