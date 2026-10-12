import { uiCopy } from "./ui-copy";
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
	shortagePolicy?: "continue_available" | "cancel_entire_order" | null;
	shortageRevision?: number;
	cancelledAt?: string | null;
	cancellationReason?: "customer_cancelled" | "shortage_cancelled" | "all_items_unavailable" | null;
	rejectionReason?: "merchant_rejected" | "auto_rejected_unanswered" | null;
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
	pending: { heading: uiCopy.customer.pending, detail: uiCopy.customer.orderSubmitted },
	accepted: { heading: uiCopy.customer.preparing, detail: uiCopy.customer.preparingDetail },
	completed: { heading: uiCopy.customer.completed, detail: uiCopy.customer.completedDetail },
	rejected: { heading: uiCopy.customer.rejected, detail: uiCopy.customer.rejectedDetail },
	cancelled: { heading: uiCopy.customer.cancelled, detail: uiCopy.customer.cancelledDetail },
};

export function shouldPollOrderStatus(status: OrderStatus) {
	return status === "pending" || status === "accepted";
}

export function isCustomerOrderActive(
	order: Pick<CustomerOrder, "status" | "estimatedReadyAt">,
	now = Date.now(),
) {
	if (!shouldPollOrderStatus(order.status)) return false;
	const deadline = Date.parse(order.estimatedReadyAt);
	// Preserve recovery access if a legacy snapshot has no parseable deadline.
	return Number.isNaN(deadline) || deadline > now;
}
