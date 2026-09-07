const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
const LINE_REQUEST_TIMEOUT_MS = 5_000;
const MAX_MESSAGE_ITEMS = 8;
const MAX_ITEM_NAME_LENGTH = 40;
const MAX_MESSAGE_LENGTH = 1_000;
const MAX_RECORDED_ERROR_LENGTH = 200;
const STALE_PENDING_AFTER_MS = 60_000;

export type NotificationBindings = {
	LINE_CHANNEL_ACCESS_TOKEN?: string;
	LINE_MERCHANT_RECIPIENT_ID?: string;
	MERCHANT_DEV_BYPASS?: string;
	NOTIFICATION_PROVIDER?: string;
};

export type NewOrderNotification = {
	orderNumber: string;
	total: number;
	estimatedReadyAt: string;
	items: Array<{ name: string; quantity: number }>;
};

export type MerchantNotificationDelivery = {
	id: string;
	orderNumber: string;
	channel: "line";
	eventType: "new_order";
	status: "pending" | "sent" | "failed";
	attemptCount: number;
	lastAttemptAt: string | null;
	sentAt: string | null;
	lastError: string | null;
	createdAt: string;
};

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

type DeliveryRow = {
	id: string;
	orderNumber: string;
	channel: "line";
	eventType: "new_order";
	status: "pending" | "sent" | "failed";
	attemptCount: number;
	lastAttemptAt: string | null;
	sentAt: string | null;
	lastError: string | null;
	createdAt: string;
};

type DeliveryNotificationRow = DeliveryRow & {
	total: number;
	estimatedReadyAt: string;
	orderItemId: string | null;
	itemName: string | null;
	quantity: number | null;
};

export class NotificationDeliveryError extends Error {
	constructor(
		readonly status: 404 | 409,
		readonly code:
			| "NOTIFICATION_DELIVERY_NOT_FOUND"
			| "NOTIFICATION_ALREADY_SENT"
			| "NOTIFICATION_DELIVERY_IN_PROGRESS",
		message: string,
	) {
		super(message);
		this.name = "NotificationDeliveryError";
	}
}

function toMerchantDelivery(row: DeliveryRow): MerchantNotificationDelivery {
	return {
		id: row.id,
		orderNumber: row.orderNumber,
		channel: row.channel,
		eventType: row.eventType,
		status: row.status,
		attemptCount: row.attemptCount,
		lastAttemptAt: row.lastAttemptAt,
		sentAt: row.sentAt,
		lastError: row.lastError,
		createdAt: row.createdAt,
	};
}

export async function listMerchantNotificationDeliveries(db: D1Database) {
	const { results } = await db
		.prepare(
			`SELECT
				deliveries.id AS id,
				orders.order_number AS orderNumber,
				deliveries.channel AS channel,
				deliveries.event_type AS eventType,
				deliveries.status AS status,
				deliveries.attempt_count AS attemptCount,
				deliveries.last_attempt_at AS lastAttemptAt,
				deliveries.sent_at AS sentAt,
				deliveries.last_error AS lastError,
				deliveries.created_at AS createdAt
			FROM notification_deliveries AS deliveries
			JOIN orders ON orders.id = deliveries.order_id
			ORDER BY
				CASE deliveries.status WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
				deliveries.created_at DESC,
				deliveries.id ASC
			LIMIT 50`,
		)
		.all<DeliveryRow>();

	return results.map(toMerchantDelivery);
}

async function getMerchantNotificationDelivery(db: D1Database, deliveryId: string) {
	const row = await db
		.prepare(
			`SELECT
				deliveries.id AS id,
				orders.order_number AS orderNumber,
				deliveries.channel AS channel,
				deliveries.event_type AS eventType,
				deliveries.status AS status,
				deliveries.attempt_count AS attemptCount,
				deliveries.last_attempt_at AS lastAttemptAt,
				deliveries.sent_at AS sentAt,
				deliveries.last_error AS lastError,
				deliveries.created_at AS createdAt
			FROM notification_deliveries AS deliveries
			JOIN orders ON orders.id = deliveries.order_id
			WHERE deliveries.id = ?`,
		)
		.bind(deliveryId)
		.first<DeliveryRow>();

	return row ? toMerchantDelivery(row) : null;
}

async function getDeliveryNotification(db: D1Database, deliveryId: string) {
	const { results } = await db
		.prepare(
			`SELECT
				deliveries.id AS id,
				orders.order_number AS orderNumber,
				deliveries.channel AS channel,
				deliveries.event_type AS eventType,
				deliveries.status AS status,
				deliveries.attempt_count AS attemptCount,
				deliveries.last_attempt_at AS lastAttemptAt,
				deliveries.sent_at AS sentAt,
				deliveries.last_error AS lastError,
				deliveries.created_at AS createdAt,
				orders.total_amount AS total,
				orders.estimated_ready_at AS estimatedReadyAt,
				order_items.id AS orderItemId,
				order_items.item_name AS itemName,
				order_items.quantity AS quantity
			FROM notification_deliveries AS deliveries
			JOIN orders ON orders.id = deliveries.order_id
			LEFT JOIN order_items ON order_items.order_id = orders.id
			WHERE deliveries.id = ?
			ORDER BY order_items.sort_order ASC, order_items.id ASC`,
		)
		.bind(deliveryId)
		.all<DeliveryNotificationRow>();
	const first = results[0];

	if (!first) {
		return null;
	}

	return {
		delivery: toMerchantDelivery(first),
		notification: {
			orderNumber: first.orderNumber,
			total: first.total,
			estimatedReadyAt: first.estimatedReadyAt,
			items: results.flatMap((row) =>
				row.orderItemId && row.itemName !== null && row.quantity !== null
					? [{ name: row.itemName, quantity: row.quantity }]
					: [],
			),
		} satisfies NewOrderNotification,
	};
}

async function throwCurrentDeliveryState(db: D1Database, deliveryId: string): Promise<never> {
	const delivery = await getMerchantNotificationDelivery(db, deliveryId);

	if (!delivery) {
		throw new NotificationDeliveryError(
			404,
			"NOTIFICATION_DELIVERY_NOT_FOUND",
			"Notification delivery not found",
		);
	}

	if (delivery.status === "sent") {
		throw new NotificationDeliveryError(
			409,
			"NOTIFICATION_ALREADY_SENT",
			"Sent notifications cannot be retried",
		);
	}

	throw new NotificationDeliveryError(
		409,
		"NOTIFICATION_DELIVERY_IN_PROGRESS",
		"Notification delivery is already in progress",
	);
}

async function attemptNotificationDelivery(
	db: D1Database,
	deliveryId: string,
	order: NewOrderNotification,
	provider: NotificationProvider,
	now: Date,
	mode: "initial" | "retry",
) {
	const claimStatement =
		mode === "initial"
			? db.prepare(
					`UPDATE notification_deliveries
					SET status = 'pending', attempt_count = attempt_count + 1, last_attempt_at = ?
					WHERE id = ? AND status = 'pending' AND attempt_count = 0
					RETURNING attempt_count AS attemptCount`,
				)
			: db.prepare(
					`UPDATE notification_deliveries
					SET status = 'pending', attempt_count = attempt_count + 1, last_attempt_at = ?
					WHERE id = ? AND (
						status = 'failed'
						OR (
							status = 'pending'
							AND (attempt_count = 0 OR last_attempt_at IS NULL OR last_attempt_at <= ?)
						)
					)
					RETURNING attempt_count AS attemptCount`,
				);
	const claim =
		mode === "initial"
			? await claimStatement
					.bind(now.toISOString(), deliveryId)
					.first<{ attemptCount: number }>()
			: await claimStatement
					.bind(
						now.toISOString(),
						deliveryId,
						new Date(now.getTime() - STALE_PENDING_AFTER_MS).toISOString(),
					)
					.first<{ attemptCount: number }>();

	if (!claim) {
		return { attempted: false as const };
	}

	try {
		await provider.notifyNewOrder(order);
		await db
			.prepare(
				`UPDATE notification_deliveries
				SET status = 'sent', sent_at = ?, last_error = NULL
				WHERE id = ? AND status = 'pending' AND attempt_count = ?`,
			)
			.bind(now.toISOString(), deliveryId, claim.attemptCount)
			.run();
		return { attempted: true as const, sent: true as const };
	} catch (error) {
		const sanitizedError = sanitizeDeliveryError(error);
		await db
			.prepare(
				`UPDATE notification_deliveries
				SET status = 'failed', last_error = ?, sent_at = NULL
				WHERE id = ? AND status = 'pending' AND attempt_count = ?`,
			)
			.bind(sanitizedError, deliveryId, claim.attemptCount)
			.run();
		return { attempted: true as const, sent: false as const, error: sanitizedError };
	}
}

export async function deliverNewOrderNotification(
	db: D1Database,
	deliveryId: string,
	order: NewOrderNotification,
	provider: NotificationProvider,
	now: Date = new Date(),
) {
	return attemptNotificationDelivery(db, deliveryId, order, provider, now, "initial");
}

export async function retryNotificationDelivery(
	db: D1Database,
	deliveryId: string,
	provider: NotificationProvider,
	now: Date = new Date(),
) {
	const context = await getDeliveryNotification(db, deliveryId);

	if (!context) {
		return throwCurrentDeliveryState(db, deliveryId);
	}

	const result = await attemptNotificationDelivery(
		db,
		deliveryId,
		context.notification,
		provider,
		now,
		"retry",
	);

	if (!result.attempted) {
		return throwCurrentDeliveryState(db, deliveryId);
	}

	const delivery = await getMerchantNotificationDelivery(db, deliveryId);
	if (!delivery) {
		throw new Error("Retried notification delivery not found");
	}

	return delivery;
}
