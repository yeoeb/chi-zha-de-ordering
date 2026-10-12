// Best effort device preference, never business state or a permission bypass.
export function maintainMerchantWakeLock(document: Document, navigator: Navigator) {
	let active = true;
	let requesting = false;
	let sentinel: WakeLockSentinel | null = null;
	const hidden = () => document.visibilityState === "hidden";
	const release = () => {
		const current = sentinel;
		sentinel = null;
		if (current) void current.release().catch(() => undefined);
	};
	const request = async () => {
		if (!active || requesting || sentinel || hidden() || !navigator.wakeLock?.request) return;
		requesting = true;
		try {
			const lock = await navigator.wakeLock.request("screen");
			if (!active || hidden()) {
				await lock.release();
			} else {
				sentinel = lock;
				lock.addEventListener("release", () => { if (sentinel === lock) sentinel = null; }, { once: true });
			}
		} catch { /* Unsupported policy, low battery or OS denial must not block orders. */ }
		finally { requesting = false; }
	};
	const visibility = () => {
		if (document.visibilityState === "hidden") release();
		else void request();
	};
	document.addEventListener("visibilitychange", visibility);
	void request();
	return () => {
		active = false;
		document.removeEventListener("visibilitychange", visibility);
		release();
	};
}
