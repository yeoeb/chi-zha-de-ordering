export type OrderStatus = "pending" | "accepted" | "completed" | "rejected" | "cancelled";

export type CustomerOrder = {
	publicLookupToken: string;
	orderNumber: string;
	status: OrderStatus;
	orderSource?: "online" | "onsite";
	customerName: string;
	customerNote: string | null;
	packagingPreference: "together" | "separate_spicy";
	createdAt: string;
	estimatedReadyAt: string;
	total: number;
	originalTotal?: number;
	shortagePolicy?: "continue_available" | "cancel_entire_order";
	shortageRevision?: number;
	cancelledAt?: string | null;
	cancellationReason?: "customer_cancelled" | "shortage_cancelled" | "all_items_unavailable" | null;
	items: Array<{
		name: string;
		unitPrice: number;
		quantity: number;
		lineTotal: number;
		modifiers: Array<{
			groupName: string;
			name: string;
			priceDelta: number;
		}>;
	}>;
	reorderItems?: Array<{ menuItemId: number; quantity: number; modifierOptionIds: number[] }>;
	shortages?: Array<{ name: string; quantity: number; amountDeducted: number }>;
};

export const CUSTOMER_STATUS_COPY: Record<
	OrderStatus,
	{ heading: string; detail: string }
> = {
	pending: { heading: "等待店家接單", detail: "訂單已送出" },
	accepted: { heading: "製作中", detail: "正在製作，請稍候" },
	completed: { heading: "餐點已完成", detail: "可以取餐了" },
	rejected: { heading: "訂單未成立", detail: "店家未接受這筆訂單" },
	cancelled: { heading: "訂單已取消", detail: "這筆訂單不會繼續製作" },
};

export function shouldPollOrderStatus(status: OrderStatus) {
	return status === "pending" || status === "accepted";
}
