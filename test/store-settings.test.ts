import { describe, expect, it } from "vitest";
import {
	assertValidStoreState,
	getStoreSettings,
	StoreSettingsError,
} from "../src/worker/store-settings";

const validStore = {
	id: 1,
	display_name: "Test Store",
	is_accepting_orders: 0,
	base_prep_minutes: 15,
	normal_order_minutes: 5,
	special_extra_minutes: 10,
	state_version: 0,
};

describe("Store settings runtime validation", () => {
	it("accepts zero and the maximum safe revision", () => {
		expect(() => assertValidStoreState(validStore)).not.toThrow();
		expect(() =>
			assertValidStoreState({ ...validStore, state_version: Number.MAX_SAFE_INTEGER }),
		).not.toThrow();
	});

	it.each([0.5, "not-a-version", -1, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid revision %s",
		(stateVersion) => {
			expect(() =>
				assertValidStoreState({ ...validStore, state_version: stateVersion }),
			).toThrow(StoreSettingsError);
		},
	);

	it("fails closed when a D1 row contains an invalid revision", async () => {
		const db = {
			prepare: () => ({
				first: async () => ({ ...validStore, state_version: 0.5 }),
			}),
		} as unknown as D1Database;

		await expect(getStoreSettings(db)).rejects.toBeInstanceOf(StoreSettingsError);
	});
});
