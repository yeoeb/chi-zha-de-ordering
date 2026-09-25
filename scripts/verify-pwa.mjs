import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, "public", "manifest.webmanifest");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const onsiteUrl = "https://chi-zha-de-ordering.yeoeb55688.workers.dev/onsite";

if (
	manifest.name !== "吃炸的" ||
	manifest.short_name !== "吃炸的" ||
	manifest.display !== "standalone" ||
	manifest.start_url !== "/merchant"
) {
	throw new Error("PWA manifest metadata is incomplete");
}

for (const size of ["192x192", "512x512"]) {
	const icon = manifest.icons?.find((candidate) => candidate.sizes === size);
	if (!icon || !existsSync(join(root, "public", icon.src.replace(/^\//, "")))) {
		throw new Error(`PWA icon ${size} is missing`);
	}
}

const serviceWorker = readFileSync(join(root, "public", "service-worker.js"), "utf8");
if (!serviceWorker.includes('url.pathname.startsWith("/api/")')) {
	throw new Error("Service Worker must bypass every API request");
}
if (
	!serviceWorker.includes('addEventListener("push"') ||
	!serviceWorker.includes('addEventListener("notificationclick"')
) {
	throw new Error("Service Worker Web Push handlers are missing");
}

function createServiceWorkerHarness(windowClients = []) {
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
		registration: { showNotification: async () => undefined },
		skipWaiting: () => undefined,
		addEventListener: (type, listener) => listeners.set(type, listener),
	};

	runInNewContext(serviceWorker, { self, URL, Promise });
	const notificationClick = listeners.get("notificationclick");
	if (typeof notificationClick !== "function") {
		throw new Error("Service Worker notificationclick handler was not registered");
	}

	return {
		origin,
		openedUrls,
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
const existingMerchantClient = {
	url: "https://merchant.example.test/merchant?source=push",
	focus: async () => {
		focusCount += 1;
	},
};
const existingClientHarness = createServiceWorkerHarness([existingMerchantClient]);
await existingClientHarness.click({ url: "https://evil.example/phishing" });
if (focusCount !== 1 || existingClientHarness.openedUrls.length !== 0) {
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
