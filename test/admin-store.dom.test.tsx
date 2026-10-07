import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/react-app/App";

const weeklyBusinessHours = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [
	String(day),
	{ isOpen: true, openAt: "17:30", closeAt: "23:15" },
]));

function json(value: unknown, status = 200) {
	return Promise.resolve(new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	}));
}

afterEach(() => {
	cleanup();
	window.history.replaceState(null, "", "/");
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Admin Store settings UI", () => {
	it("loads Store configuration and saves phone/image settings only on explicit submit", async () => {
		let stored: {
			weeklyBusinessHours: Record<string, { isOpen: boolean; openAt: string; closeAt: string }>;
			lastOrderTime: string;
			customerPhoneMode: "hidden" | "optional";
			showProductImages: boolean;
			newOrderSoundEnabled: boolean;
		} = {
			weeklyBusinessHours,
			lastOrderTime: "23:00",
			customerPhoneMode: "optional",
			showProductImages: true,
			newOrderSoundEnabled: true,
		};
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const method = init?.method ?? "GET";
			if (url !== "/api/admin/store") throw new Error(`Unexpected request: ${method} ${url}`);
			if (method === "GET") return json(stored);
			if (method === "PATCH") {
				stored = JSON.parse(String(init?.body));
				return json(stored);
			}
			throw new Error(`Unexpected request: ${method} ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		window.history.replaceState(null, "", "/admin/store");
		render(<App />);

		expect(await screen.findByRole("heading", { name: "店家設定" })).toBeTruthy();
		expect((screen.getByLabelText("最後接單時間") as HTMLInputElement).value).toBe("23:00");
		await userEvent.click(screen.getByRole("radio", { name: "不顯示" }));
		await userEvent.click(screen.getByRole("radio", { name: "關閉商品圖片" }));
		await userEvent.click(screen.getByRole("radio", { name: "關閉新單提示音" }));
		expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);

		await userEvent.click(screen.getByRole("button", { name: "儲存設定" }));
		await screen.findByText("營業與顧客點餐設定已儲存。");
		const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
		const body = JSON.parse(String(patchCall?.[1]?.body));
		expect(body).toMatchObject({
			weeklyBusinessHours,
			lastOrderTime: "23:00",
			customerPhoneMode: "hidden",
			showProductImages: false,
			newOrderSoundEnabled: false,
		});
	});

	it("preserves the draft and reports a save failure", async () => {
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			if ((init?.method ?? "GET") === "GET") return json({
				weeklyBusinessHours,
				lastOrderTime: "23:00",
				customerPhoneMode: "optional",
				showProductImages: true,
				newOrderSoundEnabled: true,
			});
			return json({ error: { message: "設定未儲存" } }, 400);
		});
		vi.stubGlobal("fetch", fetchMock);
		window.history.replaceState(null, "", "/admin/store");
		render(<App />);
		await screen.findByRole("heading", { name: "店家設定" });
		await userEvent.click(screen.getByRole("radio", { name: "不顯示" }));
		await userEvent.click(screen.getByRole("button", { name: "儲存設定" }));
		expect((await screen.findByRole("alert")).textContent).toContain("設定未儲存");
		expect((screen.getByRole("radio", { name: "不顯示" }) as HTMLInputElement).checked).toBe(true);
		await waitFor(() => expect((screen.getByRole("button", { name: "儲存設定" }) as HTMLButtonElement).disabled).toBe(false));
	});
});
