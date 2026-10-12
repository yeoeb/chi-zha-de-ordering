import { getStoreBusinessDate, getStoreBusinessDateRange } from "../shared/business-date";

export type MerchantRevenueSummary = {
	businessDate: string;
	revenue: number;
	effectiveOrderCount: number;
	averageOrderValue: number;
	itemQuantity: number;
	topItems: Array<{ name: string; quantity: number }>;
	busiestHour: string | null;
	cancelledCount: number;
	rejectedCount: number;
	soldOutItems: Array<{ id: number; name: string }>;
};

export async function getMerchantRevenueSummary(
	db: D1Database,
	now = new Date(),
): Promise<MerchantRevenueSummary> {
	const businessDate = getStoreBusinessDate(now);
	const range = getStoreBusinessDateRange(businessDate);
	if (!range) throw new RangeError("Store business date is invalid");
	const effectiveWhere = `orders.estimated_ready_at >= ? AND orders.estimated_ready_at < ?
		AND orders.status IN ('pending', 'accepted', 'completed')
		AND orders.cancelled_at IS NULL`;
	const [summary, items, busiest, soldOut] = await Promise.all([
		db.prepare(
			`SELECT
				COALESCE(SUM(CASE WHEN status IN ('pending', 'accepted', 'completed') AND cancelled_at IS NULL THEN total_amount ELSE 0 END), 0) AS revenue,
				COALESCE(SUM(CASE WHEN status IN ('pending', 'accepted', 'completed') AND cancelled_at IS NULL THEN 1 ELSE 0 END), 0) AS effectiveOrderCount,
				COALESCE(SUM(CASE WHEN cancelled_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS cancelledCount,
				COALESCE(SUM(CASE WHEN status = 'rejected' AND cancelled_at IS NULL THEN 1 ELSE 0 END), 0) AS rejectedCount
			FROM orders WHERE estimated_ready_at >= ? AND estimated_ready_at < ?`,
		).bind(range.startInclusive, range.endExclusive).first<{
			revenue: number;
			effectiveOrderCount: number;
			cancelledCount: number;
			rejectedCount: number;
		}>(),
		db.prepare(
			`SELECT order_items.item_name AS name,
				SUM(MAX(0, order_items.quantity - COALESCE(order_item_shortages.unavailable_quantity, 0))) AS quantity
			FROM orders
			JOIN order_items ON order_items.order_id = orders.id
			LEFT JOIN order_item_shortages ON order_item_shortages.order_item_id = order_items.id
			WHERE ${effectiveWhere}
			GROUP BY order_items.item_name
			HAVING quantity > 0
			ORDER BY quantity DESC, order_items.item_name ASC`,
		).bind(range.startInclusive, range.endExclusive).all<{ name: string; quantity: number }>(),
		db.prepare(
			`SELECT strftime('%H:00', orders.estimated_ready_at, '+8 hours') AS hour, COUNT(*) AS orderCount
			FROM orders WHERE ${effectiveWhere}
			GROUP BY hour ORDER BY orderCount DESC, hour ASC LIMIT 1`,
		).bind(range.startInclusive, range.endExclusive).first<{ hour: string; orderCount: number }>(),
		db.prepare(
			`SELECT items.id, items.name FROM menu_items AS items
			JOIN menu_categories AS categories ON categories.id = items.category_id
			WHERE items.is_available = 0 AND items.is_archived = 0 AND categories.is_active = 1
			ORDER BY categories.sort_order, items.sort_order, items.id`,
		).all<{ id: number; name: string }>(),
	]);
	const revenue = summary?.revenue ?? 0;
	const effectiveOrderCount = summary?.effectiveOrderCount ?? 0;
	const allItems = items.results.map((item) => ({ name: item.name, quantity: item.quantity }));
	return {
		businessDate,
		revenue,
		effectiveOrderCount,
		averageOrderValue: effectiveOrderCount > 0 ? Math.round(revenue / effectiveOrderCount) : 0,
		itemQuantity: allItems.reduce((total, item) => total + item.quantity, 0),
		topItems: allItems.slice(0, 5),
		busiestHour: busiest?.hour ?? null,
		cancelledCount: summary?.cancelledCount ?? 0,
		rejectedCount: summary?.rejectedCount ?? 0,
		soldOutItems: soldOut.results,
	};
}
