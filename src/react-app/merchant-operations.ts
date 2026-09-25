export type MerchantModifier = {
	groupName: string;
	name: string;
};

export type MerchantOrderItem = {
	id?: string;
	name: string;
	quantity: number;
	lineTotal: number;
	modifiers: MerchantModifier[];
};

export type MerchantOrder = {
	id: string;
	orderNumber: string;
	status: "pending" | "accepted" | "completed" | "rejected" | "cancelled";
	orderSource?: "online" | "onsite";
	total: number;
	originalTotal?: number;
	shortagePolicy?: "continue_available" | "cancel_entire_order";
	shortageRevision?: number;
	cancelledAt?: string | null;
	cancellationReason?: "customer_cancelled" | "shortage_cancelled" | "all_items_unavailable" | null;
	estimatedReadyAt: string;
	createdAt: string;
	acceptedAt?: string | null;
	completedAt?: string | null;
	rejectedAt?: string | null;
	customerName: string;
	customerPhone: string;
	customerNote: string | null;
	packagingPreference: "together" | "separate_spicy";
	specialOrder: boolean;
	items: MerchantOrderItem[];
	shortages?: Array<{ orderItemId: string; name: string; quantity: number; amountDeducted: number }>;
};

export type MerchantMenuItem = {
	id: number;
	name: string;
	isAvailable: boolean;
	isQuickSoldOut?: boolean;
};

export type MerchantMenuCategory = {
	id: number;
	name: string;
	items: MerchantMenuItem[];
};

export type MerchantViewName = "orders" | "availability";

export type DeadlineState = {
	className: "normal" | "approaching" | "urgent" | "overdue";
	label: string;
};

export function getDeadlineState(estimatedReadyAt: string, now = new Date()): DeadlineState {
	const differenceMs = new Date(estimatedReadyAt).getTime() - now.getTime();
	if (!Number.isFinite(differenceMs)) {
		return { className: "normal", label: "截止時間未記錄" };
	}
	if (differenceMs < 0) {
		return {
			className: "overdue",
			label: `已逾時 ${Math.max(1, Math.ceil(Math.abs(differenceMs) / 60_000))} 分`,
		};
	}

	const minutes = Math.max(1, Math.ceil(differenceMs / 60_000));
	return {
		className: minutes <= 5 ? "urgent" : minutes <= 10 ? "approaching" : "normal",
		label: `剩 ${minutes} 分`,
	};
}

export function sortOrdersByReadyDeadline(orders: MerchantOrder[]) {
	return [...orders].sort((left, right) => {
		const leftDeadline = new Date(left.estimatedReadyAt).getTime();
		const rightDeadline = new Date(right.estimatedReadyAt).getTime();
		const deadlineDifference =
			(Number.isFinite(leftDeadline) ? leftDeadline : Number.POSITIVE_INFINITY) -
			(Number.isFinite(rightDeadline) ? rightDeadline : Number.POSITIVE_INFINITY);
		return deadlineDifference || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
	});
}
