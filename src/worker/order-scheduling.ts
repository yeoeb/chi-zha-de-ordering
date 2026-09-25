import { getPreparationTimeEstimate } from "./preparation-time-policy";

const SCHEDULING_UNIT_MINUTES = 5;
const SCHEDULING_UNIT_MS = SCHEDULING_UNIT_MINUTES * 60_000;

export type KitchenScheduleOrder = {
	id: string;
	status: "pending" | "accepted";
	orderSource: "online" | "onsite";
	specialOrder: boolean;
	estimatedReadyAt: string;
	createdAt: string;
};

export type KitchenScheduleSettings = {
	basePrepMinutes: number;
	normalOrderMinutes: number;
	specialExtraMinutes: number;
};

type Reservation = { start: number; end: number };

function requireValidDate(date: Date, name: string) {
	if (Number.isNaN(date.getTime())) throw new RangeError(`${name} must be a valid date`);
}

function roundUpToUnit(value: number) {
	return Math.ceil(value / SCHEDULING_UNIT_MS) * SCHEDULING_UNIT_MS;
}

export function getOrderCapacityMinutes(
	settings: KitchenScheduleSettings,
	specialOrder: boolean,
) {
	const rawMinutes =
		settings.normalOrderMinutes + (specialOrder ? settings.specialExtraMinutes : 0);
	if (!Number.isInteger(rawMinutes) || rawMinutes < 0) {
		throw new RangeError("Order capacity inputs must be non-negative integers");
	}
	return Math.max(
		SCHEDULING_UNIT_MINUTES,
		Math.ceil(rawMinutes / SCHEDULING_UNIT_MINUTES) * SCHEDULING_UNIT_MINUTES,
	);
}

function reservationsFor(
	orders: readonly KitchenScheduleOrder[],
	settings: KitchenScheduleSettings,
) {
	return orders.flatMap<Reservation>((order) => {
		const end = new Date(order.estimatedReadyAt).getTime();
		if (!Number.isFinite(end)) return [];
		const duration = getOrderCapacityMinutes(settings, order.specialOrder) * 60_000;
		return [{ start: end - duration, end }];
	}).sort((left, right) => left.start - right.start || left.end - right.end);
}

function findEarliestCompletion(
	reservations: readonly Reservation[],
	durationMinutes: number,
	notBefore: Date,
) {
	requireValidDate(notBefore, "notBefore");
	const duration = durationMinutes * 60_000;
	let candidateStart = roundUpToUnit(notBefore.getTime());

	for (const reservation of reservations) {
		if (reservation.end <= candidateStart) continue;
		if (candidateStart + duration <= reservation.start) {
			return candidateStart + duration;
		}
		candidateStart = Math.max(candidateStart, reservation.end);
	}

	return candidateStart + duration;
}

export function createKitchenScheduleFingerprint(orders: readonly KitchenScheduleOrder[]) {
	return [...orders]
		.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
		.map((order) => [
			order.id,
			order.status,
			order.orderSource,
			order.specialOrder ? "1" : "0",
			order.estimatedReadyAt,
		].join(":"))
		.join("|");
}

export function scheduleNewOnsiteOrder(
	orders: readonly KitchenScheduleOrder[],
	settings: KitchenScheduleSettings,
	specialOrder: boolean,
	now: Date,
) {
	requireValidDate(now, "now");
	const durationMinutes = getOrderCapacityMinutes(settings, specialOrder);
	const emptyQueueEstimate = getPreparationTimeEstimate({
		basePrepMinutes: settings.basePrepMinutes,
		normalOrderMinutes: settings.normalOrderMinutes,
		specialExtraMinutes: settings.specialExtraMinutes,
		ordersAhead: 0,
		specialOrdersAhead: 0,
	}, now);
	const earliestCompletion = new Date(emptyQueueEstimate.estimatedReadyAt).getTime();
	const notBefore = new Date(earliestCompletion - durationMinutes * 60_000);
	const completion = findEarliestCompletion(
		reservationsFor(orders, settings),
		durationMinutes,
		notBefore,
	);
	return new Date(completion).toISOString();
}

export function planPendingOnsiteAdvances(
	orders: readonly KitchenScheduleOrder[],
	settings: KitchenScheduleSettings,
	now: Date,
) {
	requireValidDate(now, "now");
	const movable = orders
		.filter((order) => order.status === "pending" && order.orderSource === "onsite")
		.sort((left, right) =>
			left.estimatedReadyAt.localeCompare(right.estimatedReadyAt) ||
			left.createdAt.localeCompare(right.createdAt) ||
			left.id.localeCompare(right.id),
		);
	const fixed = orders.filter(
		(order) => order.status === "accepted" || order.orderSource === "online",
	);
	const reservations = reservationsFor(fixed, settings);
	const updates: Array<{ id: string; from: string; to: string }> = [];

	for (const order of movable) {
		const durationMinutes = getOrderCapacityMinutes(settings, order.specialOrder);
		const proposedMs = findEarliestCompletion(reservations, durationMinutes, now);
		const currentMs = new Date(order.estimatedReadyAt).getTime();
		const finalMs = Number.isFinite(currentMs) ? Math.min(currentMs, proposedMs) : proposedMs;
		const finalReadyAt = new Date(finalMs).toISOString();
		if (finalReadyAt !== order.estimatedReadyAt) {
			updates.push({ id: order.id, from: order.estimatedReadyAt, to: finalReadyAt });
		}
		reservations.push({
			start: finalMs - durationMinutes * 60_000,
			end: finalMs,
		});
		reservations.sort((left, right) => left.start - right.start || left.end - right.end);
	}

	return updates;
}

export const ACTIVE_SCHEDULE_FINGERPRINT_SQL = `(
	SELECT COALESCE(group_concat(schedule_value, '|'), '')
	FROM (
		SELECT
			id || ':' || status || ':' || order_source || ':' || special_order || ':' || estimated_ready_at
				AS schedule_value
		FROM orders
		WHERE status IN ('pending', 'accepted')
		ORDER BY id ASC
	)
)`;

export async function readActiveKitchenSchedule(db: D1Database) {
	const { results } = await db.prepare(
		`SELECT
			id,
			status,
			order_source AS orderSource,
			special_order AS specialOrder,
			estimated_ready_at AS estimatedReadyAt,
			created_at AS createdAt
		FROM orders
		WHERE status IN ('pending', 'accepted')
		ORDER BY id ASC`,
	).all<{
		id: string;
		status: "pending" | "accepted";
		orderSource: "online" | "onsite";
		specialOrder: number;
		estimatedReadyAt: string;
		createdAt: string;
	}>();

	return results.map((row) => ({
		...row,
		specialOrder: Boolean(row.specialOrder),
	} satisfies KitchenScheduleOrder));
}

export async function advancePendingOnsiteOrders(
	db: D1Database,
	settings: KitchenScheduleSettings,
	now: Date,
) {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const schedule = await readActiveKitchenSchedule(db);
		const updates = planPendingOnsiteAdvances(schedule, settings, now);
		if (updates.length === 0) return [];
		const fingerprint = createKitchenScheduleFingerprint(schedule);
		const caseSql = updates.map(() => "WHEN ? THEN ?").join(" ");
		const idSql = updates.map(() => "?").join(", ");
		const bindings = updates.flatMap((update) => [update.id, update.to]);
		const result = await db.prepare(
			`UPDATE orders
			SET estimated_ready_at = CASE id ${caseSql} ELSE estimated_ready_at END
			WHERE status = 'pending'
				AND order_source = 'onsite'
				AND id IN (${idSql})
				AND ${ACTIVE_SCHEDULE_FINGERPRINT_SQL} = ?`,
		).bind(...bindings, ...updates.map((update) => update.id), fingerprint).run();
		if (result.meta.changes === updates.length) return updates;
	}
	return [];
}
