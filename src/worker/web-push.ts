import {
	buildPushPayload,
	type PushMessage,
	type PushSubscription,
	type VapidKeys,
} from "@block65/webcrypto-web-push";
import {
	NotificationProviderError,
	type NewOrderNotification,
	type NotificationProvider,
} from "./notifications";

const MAX_PUSH_ENDPOINT_LENGTH = 2_048;
const MAX_PUSH_KEY_LENGTH = 512;

export type WebPushBindings = {
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT?: string;
};

export type PushSubscriptionInput = {
	endpoint: string;
	expirationTime: number | null;
	keys: { p256dh: string; auth: string };
};

type StoredPushSubscription = {
	id: string;
	endpoint: string;
	p256dh: string;
	auth: string;
};

export class PushSubscriptionRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PushSubscriptionRequestError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePushSubscription(input: unknown): PushSubscriptionInput {
	if (!isRecord(input) || !isRecord(input.keys)) {
		throw new PushSubscriptionRequestError("Push subscription is invalid");
	}

	const allowedKeys = new Set(["endpoint", "expirationTime", "keys"]);
	const allowedSubscriptionKeys = new Set(["p256dh", "auth"]);
	if (
		Object.keys(input).some((key) => !allowedKeys.has(key)) ||
		Object.keys(input.keys).some((key) => !allowedSubscriptionKeys.has(key))
	) {
		throw new PushSubscriptionRequestError("Push subscription contains unsupported fields");
	}

	const endpoint = typeof input.endpoint === "string" ? input.endpoint.trim() : "";
	const p256dh = typeof input.keys.p256dh === "string" ? input.keys.p256dh.trim() : "";
	const auth = typeof input.keys.auth === "string" ? input.keys.auth.trim() : "";
	const expirationTime = input.expirationTime === undefined ? null : input.expirationTime;
	let endpointUrl: URL;

	try {
		endpointUrl = new URL(endpoint);
	} catch {
		throw new PushSubscriptionRequestError("Push subscription endpoint must be a valid URL");
	}

	if (
		endpointUrl.protocol !== "https:" ||
		endpoint.length === 0 ||
		endpoint.length > MAX_PUSH_ENDPOINT_LENGTH ||
		p256dh.length === 0 ||
		p256dh.length > MAX_PUSH_KEY_LENGTH ||
		auth.length === 0 ||
		auth.length > MAX_PUSH_KEY_LENGTH ||
		(expirationTime !== null &&
			(typeof expirationTime !== "number" ||
				!Number.isFinite(expirationTime) ||
				expirationTime < 0))
	) {
		throw new PushSubscriptionRequestError("Push subscription values are invalid");
	}

	return { endpoint, expirationTime, keys: { p256dh, auth } };
}

export function parsePushUnsubscribeRequest(input: unknown) {
	if (!isRecord(input) || Object.keys(input).length !== 1 || typeof input.endpoint !== "string") {
		throw new PushSubscriptionRequestError("Push unsubscribe request is invalid");
	}

	const endpoint = input.endpoint.trim();
	if (!endpoint || endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) {
		throw new PushSubscriptionRequestError("Push subscription endpoint is invalid");
	}

	return endpoint;
}

export async function saveMerchantPushSubscription(
	db: D1Database,
	subscription: PushSubscriptionInput,
	now: Date = new Date(),
) {
	const timestamp = now.toISOString();
	await db
		.prepare(
			`INSERT INTO merchant_push_subscriptions (
				id, endpoint, p256dh, auth, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(endpoint) DO UPDATE SET
				p256dh = excluded.p256dh,
				auth = excluded.auth,
				updated_at = excluded.updated_at`,
		)
		.bind(
			crypto.randomUUID(),
			subscription.endpoint,
			subscription.keys.p256dh,
			subscription.keys.auth,
			timestamp,
			timestamp,
		)
		.run();

	return { subscribed: true as const };
}

export async function removeMerchantPushSubscription(db: D1Database, endpoint: string) {
	await db
		.prepare("DELETE FROM merchant_push_subscriptions WHERE endpoint = ?")
		.bind(endpoint)
		.run();
	return { subscribed: false as const };
}

export function getVapidPublicKey(bindings: WebPushBindings) {
	const publicKey = bindings.VAPID_PUBLIC_KEY?.trim();
	return publicKey && publicKey.length <= MAX_PUSH_KEY_LENGTH ? publicKey : null;
}

export function buildWebPushMessage(notification: NewOrderNotification): PushMessage<string> {
	return {
		data: JSON.stringify({
			title: "吃炸的｜新訂單",
			body: `新訂單 #${notification.orderNumber}`,
			data: { url: "/merchant" },
		}),
		options: { ttl: 300, urgency: "high" },
	};
}

export type WebPushSender = (
	subscription: PushSubscription,
	message: PushMessage<string>,
	vapid: VapidKeys,
) => Promise<Response>;

const defaultWebPushSender: WebPushSender = async (subscription, message, vapid) =>
	fetch(subscription.endpoint, await buildPushPayload(message, subscription, vapid));

export class WebPushNotificationProvider implements NotificationProvider {
	constructor(
		private readonly db: D1Database,
		private readonly vapid: VapidKeys,
		private readonly sender: WebPushSender = defaultWebPushSender,
	) {}

	async notifyNewOrder(notification: NewOrderNotification) {
		const { results } = await this.db
			.prepare(
				"SELECT id, endpoint, p256dh, auth FROM merchant_push_subscriptions ORDER BY created_at ASC, id ASC",
			)
			.all<StoredPushSubscription>();

		if (results.length === 0) {
			throw new NotificationProviderError(
				"WEB_PUSH_NOT_SUBSCRIBED",
				"Merchant has no Web Push subscription",
			);
		}

		const attemptedAt = new Date().toISOString();
		let successCount = 0;
		for (const stored of results) {
			try {
				const response = await this.sender(
					{
						endpoint: stored.endpoint,
						expirationTime: null,
						keys: { p256dh: stored.p256dh, auth: stored.auth },
					},
					buildWebPushMessage(notification),
					this.vapid,
				);

				if (response.ok) {
					successCount += 1;
					await this.db
						.prepare(
							"UPDATE merchant_push_subscriptions SET last_success_at = ?, updated_at = ? WHERE id = ?",
						)
						.bind(attemptedAt, attemptedAt, stored.id)
						.run();
				} else if (response.status === 404 || response.status === 410) {
					await this.db
						.prepare("DELETE FROM merchant_push_subscriptions WHERE id = ?")
						.bind(stored.id)
						.run();
				} else {
					await this.recordFailure(stored.id, attemptedAt);
				}
			} catch {
				await this.recordFailure(stored.id, attemptedAt);
			}
		}

		if (successCount === 0) {
			throw new NotificationProviderError(
				"WEB_PUSH_DELIVERY_FAILED",
				"Web Push delivery failed for every Merchant subscription",
			);
		}
	}

	private async recordFailure(subscriptionId: string, attemptedAt: string) {
		await this.db
			.prepare(
				"UPDATE merchant_push_subscriptions SET last_failure_at = ?, updated_at = ? WHERE id = ?",
			)
			.bind(attemptedAt, attemptedAt, subscriptionId)
			.run();
	}
}

class DisabledWebPushNotificationProvider implements NotificationProvider {
	async notifyNewOrder() {
		throw new NotificationProviderError(
			"WEB_PUSH_NOT_CONFIGURED",
			"Merchant Web Push is not configured",
		);
	}
}

export function createNotificationProvider(
	bindings: WebPushBindings,
	db: D1Database,
	sender: WebPushSender = defaultWebPushSender,
): NotificationProvider {
	const publicKey = getVapidPublicKey(bindings);
	const privateKey = bindings.VAPID_PRIVATE_KEY?.trim();
	const subject = bindings.VAPID_SUBJECT?.trim();

	if (
		publicKey &&
		privateKey &&
		privateKey.length <= MAX_PUSH_KEY_LENGTH &&
		subject &&
		subject.length <= 320 &&
		(subject.startsWith("mailto:") || subject.startsWith("https://"))
	) {
		return new WebPushNotificationProvider(
			db,
			{ publicKey, privateKey, subject },
			sender,
		);
	}

	return new DisabledWebPushNotificationProvider();
}
