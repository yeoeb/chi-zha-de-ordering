const SHELL_CACHE = "chi-zha-de-shell-v4";
const MERCHANT_PATH = "/merchant";
const DEFAULT_PUSH_TITLE = "吃炸的｜新訂單";
const DEFAULT_PUSH_BODY = "有一筆新訂單待處理";
const SHELL_FILES = [
	"/",
	"/manifest.webmanifest?v=red-zha-1",
	"/icons/icon.svg?v=red-zha-1",
	"/icons/favicon-32.png?v=red-zha-1",
	"/favicon.ico?v=red-zha-1",
	"/icons/apple-touch-icon-180.png?v=red-zha-1",
	"/icons/icon-192.png?v=red-zha-1",
	"/icons/icon-512.png?v=red-zha-1",
];

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key))),
			)
			.then(() => self.clients.claim()),
	);
});

async function cacheSuccessfulResponse(cacheKey, response) {
	if (response.ok && response.type === "basic") {
		const cache = await caches.open(SHELL_CACHE);
		await cache.put(cacheKey, response.clone());
	}
	return response;
}

async function handleNavigation(request) {
	try {
		return await cacheSuccessfulResponse(request, await fetch(request));
	} catch {
		return (await caches.match(request)) ?? (await caches.match("/")) ?? Response.error();
	}
}

async function handleStaticAsset(request) {
	const cached = await caches.match(request);
	if (cached) {
		return cached;
	}

	return cacheSuccessfulResponse(request, await fetch(request));
}

self.addEventListener("fetch", (event) => {
	const request = event.request;
	const url = new URL(request.url);

	if (
		request.method !== "GET" ||
		url.origin !== self.location.origin ||
		url.pathname.startsWith("/api/")
	) {
		return;
	}

	if (request.mode === "navigate") {
		event.respondWith(handleNavigation(request));
		return;
	}

	if (["script", "style", "image", "font", "manifest"].includes(request.destination)) {
		event.respondWith(handleStaticAsset(request));
	}
});

self.addEventListener("push", (event) => {
	let payload = {};
	try {
		payload = event.data?.json() ?? {};
	} catch {
		payload = {};
	}

	const title =
		typeof payload.title === "string" && payload.title.trim()
			? payload.title.trim().slice(0, 100)
			: DEFAULT_PUSH_TITLE;
	const body =
		typeof payload.body === "string" && payload.body.trim()
			? payload.body.trim().slice(0, 200)
			: DEFAULT_PUSH_BODY;
	const notificationTag =
		typeof payload.data?.tag === "string" && payload.data.tag.startsWith("order:")
			? payload.data.tag
			: "new-order";
	event.waitUntil(
		self.registration.showNotification(title, {
			body,
			icon: "/icons/icon-192.png",
			badge: "/icons/icon-192.png",
			vibrate: [200, 100, 200],
			tag: notificationTag,
			data: { url: MERCHANT_PATH },
		}),
	);
});

self.addEventListener("message", (event) => {
	if (event.data?.type !== "CLOSE_ORDER_NOTIFICATION" || typeof event.data.orderId !== "string") return;
	event.waitUntil(
		self.registration.getNotifications({ tag: `order:${event.data.orderId}` })
			.then((notifications) => notifications.forEach((notification) => notification.close())),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const targetUrl = new URL(MERCHANT_PATH, self.location.origin).href;

	event.waitUntil(
		self.clients
			.matchAll({ type: "window", includeUncontrolled: true })
			.then(async (clients) => {
				const merchantClient = clients.find((client) => {
					try {
						const clientUrl = new URL(client.url);
						return (
							clientUrl.origin === self.location.origin &&
							(clientUrl.pathname === MERCHANT_PATH ||
								clientUrl.pathname.startsWith(`${MERCHANT_PATH}/`))
						);
					} catch {
						return false;
					}
				});
				if (merchantClient) {
					merchantClient.postMessage({ type: "MERCHANT_NOTIFICATION_OPEN" });
					return merchantClient.focus();
				}
				return self.clients.openWindow(targetUrl);
			}),
	);
});
