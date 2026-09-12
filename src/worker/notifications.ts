const MAX_RECORDED_ERROR_LENGTH = 200;
const STALE_PENDING_AFTER_MS = 60_000;

export type NewOrderNotification = {
	orderNumber: string;
	total: number;
	estimatedReadyAt: string;
	items: Array<{ name: string; quantity: number }>;
};

export type MerchantNotificationDelivery = {
	id: string;
	orderNumber: string;
	channel: "line" | "web_push";
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
	channel: "line" | "web_push";
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

const DELIVERY_SOURCE_CTE = `WITH deliveries AS (
	SELECT
		id, order_id, channel, event_type, status, attempt_count,
		last_attempt_at, sent_at, last_error, created_at
	FROM notification_deliveries
	UNION ALL
	SELECT
		id, order_id, 'web_push' AS channel, event_type, status, attempt_count,
		last_attempt_at, sent_at, last_error, created_at
	FROM web_push_notification_deliveries
)`;

export class NotificationDeliveryError extends Error {
	constructor(
		readonly status: 404 | 409,
		readonly code:
			| "NOTIFICATION_DELIVERY_NOT_FOUND"
			| "NOTIFICATION_ALREADY_SENT"
			| "NOTIFICATION_DELIVERY_IN_PROGRESS"
			| "NOTIFICATION_CHANNEL_RETIRED",
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
			`${DELIVERY_SOURCE_CTE}
			SELECT
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
			FROM deliveries
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
			`${DELIVERY_SOURCE_CTE}
			SELECT
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
			FROM deliveries
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
			`${DELIVERY_SOURCE_CTE}
			SELECT
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
			FROM deliveries
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
					`UPDATE web_push_notification_deliveries
					SET status = 'pending', attempt_count = attempt_count + 1, last_attempt_at = ?
					WHERE id = ? AND status = 'pending' AND attempt_count = 0
					RETURNING attempt_count AS attemptCount`,
				)
			: db.prepare(
					`UPDATE web_push_notification_deliveries
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
				`UPDATE web_push_notification_deliveries
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
				`UPDATE web_push_notification_deliveries
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
	if (context.delivery.channel !== "web_push") {
		throw new NotificationDeliveryError(
			409,
			"NOTIFICATION_CHANNEL_RETIRED",
			"This historical notification channel is retired",
		);
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
