import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "public", "manifest.webmanifest");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const onsiteUrl = "https://chi-zha-de-ordering.yeoeb55688.workers.dev/onsite";

if (
	manifest.name !== "吃炸的" ||
	manifest.short_name !== "吃炸的" ||
	manifest.display !== "standalone" ||
	manifest.start_url !== "/merchant" ||
	manifest.theme_color !== "#ffffff" ||
	manifest.background_color !== "#ffffff"
) {
	throw new Error("PWA manifest metadata is incomplete");
}
if (
	!indexHtml.includes('content="#ffffff" media="(prefers-color-scheme: light)"') ||
	!indexHtml.includes('content="#000000" media="(prefers-color-scheme: dark)"')
) {
	throw new Error("Light and dark browser theme-color metadata is incomplete");
}

const iconVersion = "red-zha-1";
const publicAssetPath = (assetUrl) =>
	join(root, "public", new URL(assetUrl, "https://chizhade.com").pathname.replace(/^\//, ""));
const assertPngSize = (assetUrl, size) => {
	const png = readFileSync(publicAssetPath(assetUrl));
	if (
		png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
		png.readUInt32BE(16) !== size ||
		png.readUInt32BE(20) !== size
	) {
		throw new Error(`PNG icon ${assetUrl} must be ${size}x${size}`);
	}
};

for (const size of ["192x192", "512x512"]) {
	const icon = manifest.icons?.find((candidate) => candidate.sizes === size);
	if (!icon || icon.purpose !== "any maskable" || !icon.src.endsWith(`?v=${iconVersion}`) || !existsSync(publicAssetPath(icon.src))) {
		throw new Error(`PWA icon ${size} is missing`);
	}
	assertPngSize(icon.src, Number.parseInt(size, 10));
}

for (const [asset, size] of [["/icons/favicon-32.png", 32], ["/icons/apple-touch-icon-180.png", 180]]) {
	assertPngSize(asset, size);
	if (!indexHtml.includes(`${asset}?v=${iconVersion}`)) {
		throw new Error(`HTML does not reference the versioned ${asset}`);
	}
}
for (const asset of ["/icons/icon.svg", "/favicon.ico", "/manifest.webmanifest"]) {
	if (!existsSync(publicAssetPath(asset)) || !indexHtml.includes(`${asset}?v=${iconVersion}`)) {
		throw new Error(`HTML does not reference the versioned ${asset}`);
	}
}
const svg = readFileSync(publicAssetPath("/icons/icon.svg"), "utf8");
if (!svg.includes("炸") || !["#e60012", "#ffffff", "#ffd54a"].every((color) => svg.includes(color))) {
	throw new Error("Brand icon colors or white 炸 glyph are missing");
}

const serviceWorker = readFileSync(join(root, "public", "service-worker.js"), "utf8");
if (!serviceWorker.includes('const SHELL_CACHE = "chi-zha-de-shell-v4";')) {
	throw new Error("Service Worker cache must advance to v4 for the new icons");
}
if (!serviceWorker.includes('url.pathname.startsWith("/api/")')) {
	throw new Error("Service Worker must bypass every API request");
}
if (
	!serviceWorker.includes('addEventListener("push"') ||
	!serviceWorker.includes('addEventListener("notificationclick"') ||
	!serviceWorker.includes('addEventListener("message"')
) {
	throw new Error("Service Worker Web Push handlers are missing");
}

const lifecycleListeners = new Map();
const precachedFiles = [];
const deletedCaches = [];
const cacheState = {
	open: async () => ({ addAll: async (files) => { precachedFiles.push(...files); } }),
	keys: async () => ["chi-zha-de-shell-v3", "chi-zha-de-shell-v4"],
	delete: async (key) => { deletedCaches.push(key); },
};
runInNewContext(serviceWorker, {
	self: {
		addEventListener: (type, listener) => lifecycleListeners.set(type, listener),
		skipWaiting: () => undefined,
		clients: { claim: async () => undefined },
	},
	caches: cacheState,
	URL,
	Promise,
});
for (const eventName of ["install", "activate"]) {
	let work;
	lifecycleListeners.get(eventName)({ waitUntil: (promise) => { work = promise; } });
	await work;
}
for (const asset of ["/manifest.webmanifest", "/icons/icon.svg", "/icons/favicon-32.png", "/favicon.ico", "/icons/apple-touch-icon-180.png", "/icons/icon-192.png", "/icons/icon-512.png"]) {
	if (!precachedFiles.includes(`${asset}?v=${iconVersion}`)) {
		throw new Error(`Service Worker does not precache the new ${asset}`);
	}
}
if (deletedCaches.length !== 1 || deletedCaches[0] !== "chi-zha-de-shell-v3") {
	throw new Error("Service Worker must remove the old icon cache on activation");
}

function createServiceWorkerHarness(windowClients = [], visibleNotifications = []) {
	const listeners = new Map();
	const openedUrls = [];
	const origin = "https://merchant.example.test";
	const self = {
		location: { origin },
		clients: {
			matchAll: async () => windowClients,
			openWindow: async (url) => {
				openedUrls.push(url);
				return null;
			},
		},
		registration: {
			showNotification: async () => undefined,
			getNotifications: async ({ tag }) => visibleNotifications.filter((notification) => notification.tag === tag),
		},
		skipWaiting: () => undefined,
		addEventListener: (type, listener) => listeners.set(type, listener),
	};

	runInNewContext(serviceWorker, { self, URL, Promise });
	const notificationClick = listeners.get("notificationclick");
	const message = listeners.get("message");
	if (typeof notificationClick !== "function") {
		throw new Error("Service Worker notificationclick handler was not registered");
	}

	return {
		origin,
		openedUrls,
		async closeOrderNotification(orderId) {
			let work;
			message({
				data: { type: "CLOSE_ORDER_NOTIFICATION", orderId },
				waitUntil: (promise) => { work = promise; },
			});
			if (!work) throw new Error("message did not register notification cleanup work");
			await work;
		},
		async click(data) {
			let work;
			notificationClick({
				notification: { data, close: () => undefined },
				waitUntil: (promise) => {
					work = promise;
				},
			});
			if (!work) throw new Error("notificationclick did not register asynchronous work");
			await work;
		},
	};
}

let closedNotificationCount = 0;
const closeHarness = createServiceWorkerHarness([], [{
	tag: "order:order-123",
	close: () => { closedNotificationCount += 1; },
}]);
await closeHarness.closeOrderNotification("order-123");
if (closedNotificationCount !== 1) {
	throw new Error("Service Worker did not close the processed Order notification by stable tag");
}

for (const unsafeData of [
	{ url: "https://evil.example/phishing" },
	undefined,
	{ url: { malformed: true } },
]) {
	const harness = createServiceWorkerHarness();
	await harness.click(unsafeData);
	if (harness.openedUrls.length !== 1 || harness.openedUrls[0] !== `${harness.origin}/merchant`) {
		throw new Error("Service Worker notification clicks must open only same-origin /merchant");
	}
}

let focusCount = 0;
let syncMessages = 0;
const existingMerchantClient = {
	url: "https://merchant.example.test/merchant?source=push",
	postMessage: (message) => { if (message.type === "MERCHANT_NOTIFICATION_OPEN") syncMessages += 1; },
	focus: async () => {
		focusCount += 1;
	},
};
const existingClientHarness = createServiceWorkerHarness([existingMerchantClient]);
await existingClientHarness.click({ url: "https://evil.example/phishing" });
if (focusCount !== 1 || syncMessages !== 1 || existingClientHarness.openedUrls.length !== 0) {
	throw new Error("Service Worker must focus an existing same-origin Merchant window");
}

const ineligibleClientHarness = createServiceWorkerHarness([
	{ url: "https://merchant.example.test/merchant-phishing", focus: async () => undefined },
	{ url: "https://evil.example/merchant", focus: async () => undefined },
]);
await ineligibleClientHarness.click({ url: "/merchant" });
if (
	ineligibleClientHarness.openedUrls.length !== 1 ||
	ineligibleClientHarness.openedUrls[0] !== `${ineligibleClientHarness.origin}/merchant`
) {
	throw new Error("Service Worker must ignore ineligible windows and open same-origin /merchant");
}

const registration = readFileSync(join(root, "src", "react-app", "main.tsx"), "utf8");
if (!registration.includes('navigator.serviceWorker.register("/service-worker.js")')) {
	throw new Error("Service Worker registration is missing");
}

const onsiteQr = readFileSync(join(root, "public", "onsite-ordering-qr.svg"), "utf8");
const onsiteQrPage = readFileSync(join(root, "public", "onsite-qr.html"), "utf8");
if (
	!onsiteQr.startsWith("<svg") ||
	!onsiteQr.includes(onsiteUrl) ||
	!onsiteQrPage.includes(onsiteUrl) ||
	!onsiteQrPage.includes('/onsite-ordering-qr.svg')
) {
	throw new Error("Printable onsite QR assets do not identify the confirmed production /onsite URL");
}

console.log(
	"PWA manifest, icons, onsite QR target, API cache boundary, safe notification clicks, and registration verified.",
);
