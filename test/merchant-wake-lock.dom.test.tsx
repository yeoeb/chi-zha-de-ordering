import { afterEach, describe, expect, it, vi } from "vitest";
import { maintainMerchantWakeLock } from "../src/react-app/merchant-wake-lock";

afterEach(() => { vi.restoreAllMocks(); });
function setup() {
	let visibility: DocumentVisibilityState = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
	const locks: Array<{ release: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn> }> = [];
	const request = vi.fn(async () => {
		const lock = { release: vi.fn(async () => undefined), addEventListener: vi.fn() };
		locks.push(lock); return lock;
	});
	const navigator = { wakeLock: { request } } as unknown as Navigator;
	return { request, locks, navigator, change(value: DocumentVisibilityState) { visibility = value; document.dispatchEvent(new Event("visibilitychange")); } };
}
describe("Merchant best-effort screen wake lock", () => {
	it("requests once in foreground, releases hidden, reacquires visible and cleans up", async () => {
		const test = setup();
		const cleanup = maintainMerchantWakeLock(document, test.navigator);
		await Promise.resolve();
		expect(test.request).toHaveBeenCalledWith("screen");
		test.change("visible"); expect(test.request).toHaveBeenCalledTimes(1);
		test.change("hidden"); expect(test.locks[0].release).toHaveBeenCalledTimes(1);
		test.change("visible"); await Promise.resolve();
		expect(test.request).toHaveBeenCalledTimes(2);
		cleanup(); expect(test.locks[1].release).toHaveBeenCalledTimes(1);
		test.change("visible"); expect(test.request).toHaveBeenCalledTimes(2);
	});
	it("unsupported and OS denial are harmless and denial may retry on next resume", async () => {
		maintainMerchantWakeLock(document, {} as Navigator)();
		const test = setup(); test.request.mockRejectedValue(new Error("NotAllowedError"));
		const cleanup = maintainMerchantWakeLock(document, test.navigator);
		await Promise.resolve(); await Promise.resolve();
		test.change("hidden"); test.change("visible"); await Promise.resolve();
		expect(test.request).toHaveBeenCalledTimes(2); cleanup();
	});
	it("a late request after unmount releases instead of resurrecting the lock", async () => {
		const test = setup();
		let resolve!: (value: Awaited<ReturnType<typeof test.request>>) => void;
		test.request.mockImplementation(() => new Promise((done) => { resolve = done; }));
		const cleanup = maintainMerchantWakeLock(document, test.navigator);
		test.change("visible"); expect(test.request).toHaveBeenCalledTimes(1);
		cleanup();
		const release = vi.fn(async () => undefined);
		resolve({ release, addEventListener: vi.fn() }); await Promise.resolve();
		expect(release).toHaveBeenCalledTimes(1);
	});
});
