export type MerchantFocusOrder = { id: string; status: string; estimatedReadyAt: string };
export type MerchantFocus = "pending" | "accepted";

// Presentation events only. No order mutation or future scheduled-order schema.
export class MerchantDeadlineEvents {
	private deadlines = new Map<string, { deadline: string; fired: boolean }>();
	private initialized = false;

	observe(orders: readonly MerchantFocusOrder[], now: number) {
		const next = new Map<string, { deadline: string; fired: boolean }>();
		const crossed: string[] = [];
		for (const order of orders) {
			if (order.status !== "accepted") continue;
			const readyAt = Date.parse(order.estimatedReadyAt);
			if (!Number.isFinite(readyAt)) continue;
			const previous = this.deadlines.get(order.id);
			const sameDeadline = previous?.deadline === order.estimatedReadyAt;
			let fired = sameDeadline ? previous.fired : false;
			if (!fired && readyAt - now <= 10 * 60_000) {
				fired = true;
				if (this.initialized) crossed.push(order.id);
			}
			next.set(order.id, { deadline: order.estimatedReadyAt, fired });
		}
		this.deadlines = next; // Terminal / removed orders do not accumulate forever.
		this.initialized = true;
		return crossed;
	}
}

export function selectMerchantFocus({ newPending, deadlines, pending, accepted, allowFallback }: {
	newPending: readonly string[]; deadlines: readonly string[];
	pending: number; accepted: number; allowFallback: boolean;
}): MerchantFocus | null {
	if (newPending.length > 0) return "pending";
	if (deadlines.length > 0) return "accepted";
	if (!allowFallback || (pending > 0 && accepted > 0)) return null;
	return pending === 0 && accepted > 0 ? "accepted" : "pending";
}
