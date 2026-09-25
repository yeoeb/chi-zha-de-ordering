import { getOrderSnapshotByPublicLookupToken, type OrderStatus } from "./merchant-orders";

export type CustomerOrder = {
	publicLookupToken: string;
	orderNumber: string;
	status: OrderStatus;
	orderSource: "online" | "onsite";
	customerName: string;
	customerNote: string | null;
	packagingPreference: "together" | "separate_spicy";
	createdAt: string;
	estimatedReadyAt: string;
	total: number;
	originalTotal: number;
	shortagePolicy: "continue_available" | "cancel_entire_order";
	shortageRevision: number;
	cancelledAt: string | null;
	cancellationReason: "customer_cancelled" | "shortage_cancelled" | "all_items_unavailable" | null;
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
	reorderItems: Array<{
		menuItemId: number;
		quantity: number;
		modifierOptionIds: number[];
	}>;
	shortages: Array<{
		name: string;
		quantity: number;
		amountDeducted: number;
	}>;
};

type CustomerOrderSource = Omit<CustomerOrder, "publicLookupToken" | "items" | "reorderItems"> & {
	items: Array<{
		menuItemId: number;
		name: string;
		unitPrice: number;
		quantity: number;
		lineTotal: number;
		modifiers: Array<{
			optionId: number;
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
		orderSource: storedOrder.orderSource,
		customerName: storedOrder.customerName,
		customerNote: storedOrder.customerNote,
		packagingPreference: storedOrder.packagingPreference,
		createdAt: storedOrder.createdAt,
		estimatedReadyAt: storedOrder.estimatedReadyAt,
		total: storedOrder.total,
		originalTotal: storedOrder.originalTotal,
		shortagePolicy: storedOrder.shortagePolicy,
		shortageRevision: storedOrder.shortageRevision,
		cancelledAt: storedOrder.cancelledAt,
		cancellationReason: storedOrder.cancellationReason,
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
		reorderItems: storedOrder.items.map((item) => ({
			menuItemId: item.menuItemId,
			quantity: item.quantity,
			modifierOptionIds: item.modifiers.map((modifier) => modifier.optionId),
		})),
		shortages: storedOrder.shortages.map((shortage) => ({
			name: shortage.name,
			quantity: shortage.quantity,
			amountDeducted: shortage.amountDeducted,
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
