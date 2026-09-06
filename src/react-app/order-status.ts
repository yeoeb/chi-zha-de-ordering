export type OrderStatus = "pending" | "accepted" | "completed" | "rejected";

export type CustomerOrder = {
	id: string;
	orderNumber: string;
	status: OrderStatus;
	customerName: string;
	createdAt: string;
	estimatedReadyAt: string;
	total: number;
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
};

export const CUSTOMER_STATUS_COPY: Record<
	OrderStatus,
	{ heading: string; detail: string }
> = {
	pending: { heading: "訂單已送出", detail: "等待店家確認" },
	accepted: { heading: "店家已接受", detail: "店家正在準備您的餐點" },
	completed: { heading: "訂單已完成", detail: "餐點已完成" },
	rejected: { heading: "店家目前無法接單", detail: "本次訂單未被接受" },
};

export function shouldPollOrderStatus(status: OrderStatus) {
	return status === "pending" || status === "accepted";
}
