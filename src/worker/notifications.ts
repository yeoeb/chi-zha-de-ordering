import type { OrderSnapshot } from "./order-creation";

const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
const LINE_REQUEST_TIMEOUT_MS = 5_000;
const MAX_MESSAGE_ITEMS = 8;
const MAX_ITEM_NAME_LENGTH = 40;
const MAX_MESSAGE_LENGTH = 1_000;
const MAX_RECORDED_ERROR_LENGTH = 200;

export type NotificationBindings = {
	LINE_CHANNEL_ACCESS_TOKEN?: string;
	LINE_MERCHANT_RECIPIENT_ID?: string;
	MERCHANT_DEV_BYPASS?: string;
	NOTIFICATION_PROVIDER?: string;
};

export type NewOrderNotification = Pick<
	OrderSnapshot,
	"orderNumber" | "total" | "estimatedReadyAt" | "items"
>;

export interface NotificationProvider {
	notifyNewOrder(notification: NewOrderNotification): Promise<void>;
}

export class NotificationProviderError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "NotificationProviderError";
	}
}

export class FakeNotificationProvider implements NotificationProvider {
	readonly notifications: NewOrderNotification[] = [];

	constructor(private readonly failureCode?: string) {}

	async notifyNewOrder(notification: NewOrderNotification) {
		if (this.failureCode) {
			throw new NotificationProviderError(this.failureCode, "Fake provider delivery failed");
		}

		this.notifications.push(notification);
	}
}

class DisabledNotificationProvider implements NotificationProvider {
	async notifyNewOrder() {
		throw new NotificationProviderError(
			"NOTIFICATION_DISABLED",
			"Merchant notification delivery is disabled",
		);
	}
}

function formatReadyTime(timestamp: string) {
	return new Intl.DateTimeFormat("zh-TW", {
		timeZone: "Asia/Taipei",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date(timestamp));
}

export function buildLineNewOrderMessage(notification: NewOrderNotification) {
	const visibleItems = notification.items.slice(0, MAX_MESSAGE_ITEMS);
	const itemLines = visibleItems.map(
		(item) => `${item.name.trim().slice(0, MAX_ITEM_NAME_LENGTH)} ×${item.quantity}`,
	);

	if (notification.items.length > visibleItems.length) {
		itemLines.push(`另有 ${notification.items.length - visibleItems.length} 項`);
	}

	return [
		"吃炸的｜新訂單",
		"",
		`訂單 #${notification.orderNumber}`,
		...itemLines,
		"",
		`總計 $${notification.total}`,
		`預計 ${formatReadyTime(notification.estimatedReadyAt)}`,
		"",
		"請開啟店家系統處理",
	]
		.join("\n")
		.slice(0, MAX_MESSAGE_LENGTH);
}

type Fetcher = typeof fetch;

export class LineNotificationProvider implements NotificationProvider {
	constructor(
		private readonly channelAccessToken: string,
		private readonly recipientId: string,
		private readonly fetcher: Fetcher = fetch,
		private readonly timeoutMs = LINE_REQUEST_TIMEOUT_MS,
	) {}

	async notifyNewOrder(notification: NewOrderNotification) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		let response: Response;

		try {
			response = await this.fetcher(LINE_PUSH_ENDPOINT, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.channelAccessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					to: this.recipientId,
					messages: [{ type: "text", text: buildLineNewOrderMessage(notification) }],
				}),
				signal: controller.signal,
			});
		} catch {
			throw new NotificationProviderError(
				controller.signal.aborted ? "LINE_TIMEOUT" : "LINE_NETWORK_ERROR",
				controller.signal.aborted
					? "LINE notification request timed out"
					: "LINE notification network request failed",
			);
		} finally {
			clearTimeout(timeout);
		}

		if (!response.ok) {
			throw new NotificationProviderError(
				"LINE_HTTP_ERROR",
				`LINE notification request failed with status ${response.status}`,
			);
		}
	}
}

export function createNotificationProvider(bindings: NotificationBindings): NotificationProvider {
	if (bindings.NOTIFICATION_PROVIDER === "line") {
		const token = bindings.LINE_CHANNEL_ACCESS_TOKEN?.trim();
		const recipientId = bindings.LINE_MERCHANT_RECIPIENT_ID?.trim();

		if (token && token.length <= 4_096 && recipientId && recipientId.length <= 128) {
			return new LineNotificationProvider(token, recipientId);
		}

		return new DisabledNotificationProvider();
	}

	if (
		bindings.NOTIFICATION_PROVIDER === "fake" ||
		(bindings.NOTIFICATION_PROVIDER === undefined && bindings.MERCHANT_DEV_BYPASS === "true")
	) {
		return new FakeNotificationProvider();
	}

	return new DisabledNotificationProvider();
}

function sanitizeDeliveryError(error: unknown) {
	const message =
		error instanceof NotificationProviderError
			? `${error.code}: ${error.message}`
			: "NOTIFICATION_PROVIDER_ERROR: Merchant notification delivery failed";

	return message.slice(0, MAX_RECORDED_ERROR_LENGTH);
}

export async function deliverNewOrderNotification(
	db: D1Database,
	deliveryId: string,
	order: NewOrderNotification,
	provider: NotificationProvider,
	now: Date = new Date(),
) {
	const claim = await db
		.prepare(
			`UPDATE notification_deliveries
			SET attempt_count = attempt_count + 1
			WHERE id = ? AND status = 'pending' AND attempt_count = 0`,
		)
		.bind(deliveryId)
		.run();

	if (claim.meta.changes !== 1) {
		return { attempted: false as const };
	}

	try {
		await provider.notifyNewOrder(order);
		await db
			.prepare(
				`UPDATE notification_deliveries
				SET status = 'sent', sent_at = ?, last_error = NULL
				WHERE id = ? AND status = 'pending' AND attempt_count = 1`,
			)
			.bind(now.toISOString(), deliveryId)
			.run();
		return { attempted: true as const, sent: true as const };
	} catch (error) {
		const sanitizedError = sanitizeDeliveryError(error);
		await db
			.prepare(
				`UPDATE notification_deliveries
				SET status = 'failed', last_error = ?, sent_at = NULL
				WHERE id = ? AND status = 'pending' AND attempt_count = 1`,
			)
			.bind(sanitizedError, deliveryId)
			.run();
		return { attempted: true as const, sent: false as const, error: sanitizedError };
	}
}
