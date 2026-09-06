import { getOrderSnapshotById, type OrderStatus } from "./merchant-orders";

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

export async function getCustomerOrder(db: D1Database, orderId: string) {
	const storedOrder = await getOrderSnapshotById(db, orderId);

	if (!storedOrder) {
		return null;
	}

	const order: CustomerOrder = {
		id: storedOrder.id,
		orderNumber: storedOrder.orderNumber,
		status: storedOrder.status,
		customerName: storedOrder.customerName,
		createdAt: storedOrder.createdAt,
		estimatedReadyAt: storedOrder.estimatedReadyAt,
		total: storedOrder.total,
		items: storedOrder.items.map((item) => ({
			name: item.name,
			unitPrice: item.unitPrice,
			quantity: item.quantity,
			lineTotal: item.lineTotal,
			modifiers: item.modifiers.map((modifier) => ({
				groupName: modifier.groupName,
				name: modifier.name,
				priceDelta: modifier.priceDelta,
			})),
		})),
	};

	return order;
}
