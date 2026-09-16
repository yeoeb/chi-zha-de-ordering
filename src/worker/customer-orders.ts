import { getOrderSnapshotByPublicLookupToken, type OrderStatus } from "./merchant-orders";

export type CustomerOrder = {
	publicLookupToken: string;
	orderNumber: string;
	status: OrderStatus;
	customerName: string;
	customerNote: string | null;
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

type CustomerOrderSource = Omit<CustomerOrder, "publicLookupToken" | "items"> & {
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

export function toCustomerOrder(
	storedOrder: CustomerOrderSource,
	publicLookupToken: string,
): CustomerOrder {
	return {
		publicLookupToken,
		orderNumber: storedOrder.orderNumber,
		status: storedOrder.status,
		customerName: storedOrder.customerName,
		customerNote: storedOrder.customerNote,
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
}

export async function getCustomerOrder(db: D1Database, publicLookupToken: string) {
	const storedOrder = await getOrderSnapshotByPublicLookupToken(db, publicLookupToken);

	if (!storedOrder) {
		return null;
	}

	return toCustomerOrder(storedOrder, publicLookupToken);
}
