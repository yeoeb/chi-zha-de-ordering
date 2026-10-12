import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const mutationHeaders = {
	"Content-Type": "application/json",
	Origin: "https://example.com",
	"Sec-Fetch-Site": "same-origin",
};

const schedule = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [
	String(day),
	{ isOpen: true, openAt: "17:30", closeAt: "23:15" },
]));

beforeEach(async () => {
	await env.DB.prepare(
		"UPDATE store_settings SET weekly_business_hours = NULL, last_order_time = NULL, customer_phone_mode = 'optional', show_product_images = 1, new_order_sound_enabled = 1 WHERE id = 1",
	).run();
});

describe("Admin Store configuration", () => {
	it("allows an exact loopback same-origin Admin mutation only under the local bypass", async () => {
		const response = await exports.default.fetch("http://127.0.0.1:5173/api/admin/store", {
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
				Origin: "http://127.0.0.1:5173",
				"Sec-Fetch-Site": "same-origin",
			},
			body: JSON.stringify({
				weeklyBusinessHours: schedule,
				lastOrderTime: "23:00",
				customerPhoneMode: "optional",
				showProductImages: true,
				newOrderSoundEnabled: true,
			}),
		});

		expect(response.status).toBe(200);
	});

	it("saves validated Store configuration and exposes only public customer fields", async () => {
		const update = await exports.default.fetch("https://example.com/api/admin/store", {
			method: "PATCH",
			headers: mutationHeaders,
			body: JSON.stringify({
				weeklyBusinessHours: schedule,
				lastOrderTime: "23:00",
				customerPhoneMode: "hidden",
				showProductImages: false,
				newOrderSoundEnabled: false,
			}),
		});
		expect(update.status).toBe(200);
		expect(await update.json()).toMatchObject({
			weeklyBusinessHours: schedule,
			lastOrderTime: "23:00",
			customerPhoneMode: "hidden",
			showProductImages: false,
			newOrderSoundEnabled: false,
		});

		const publicResponse = await exports.default.fetch("https://example.com/api/store");
		const publicBody = await publicResponse.json() as Record<string, unknown>;
		expect(publicResponse.status).toBe(200);
		expect(publicBody).toMatchObject({
			todayIsOpen: true,
			todayOpenAt: "17:30",
			todayCloseAt: "23:15",
			lastOrderAt: "23:00",
			customerPhoneMode: "hidden",
			showProductImages: false,
			newOrderSoundEnabled: false,
		});
		expect(publicBody).not.toHaveProperty("weeklyBusinessHours");
	});

	it("rejects unknown fields and malformed schedules without changing stored settings", async () => {
		for (const body of [
			{ weeklyBusinessHours: schedule, lastOrderTime: "23:00", customerPhoneMode: "optional", showProductImages: true, newOrderSoundEnabled: true, price: 1 },
			{ weeklyBusinessHours: { 0: schedule["0"] }, lastOrderTime: "23:00", customerPhoneMode: "optional", showProductImages: true, newOrderSoundEnabled: true },
			{ weeklyBusinessHours: schedule, lastOrderTime: "25:00", customerPhoneMode: "optional", showProductImages: true, newOrderSoundEnabled: true },
			{ weeklyBusinessHours: schedule, lastOrderTime: "23:00", customerPhoneMode: "required", showProductImages: true, newOrderSoundEnabled: true },
			{ weeklyBusinessHours: schedule, lastOrderTime: "23:00", customerPhoneMode: "optional", showProductImages: true, newOrderSoundEnabled: "yes" },
		]) {
			const response = await exports.default.fetch("https://example.com/api/admin/store", {
				method: "PATCH",
				headers: mutationHeaders,
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: "INVALID_ADMIN_STORE" } });
		}
		const stored = await env.DB.prepare(
			"SELECT weekly_business_hours AS hours, last_order_time AS lastOrder, customer_phone_mode AS phoneMode, show_product_images AS images, new_order_sound_enabled AS sound FROM store_settings WHERE id = 1",
		).first();
		expect(stored).toEqual({ hours: null, lastOrder: null, phoneMode: "optional", images: 1, sound: 1 });
	});
});
