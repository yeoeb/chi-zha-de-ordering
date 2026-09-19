export type MerchantModifier = {
	groupName: string;
	name: string;
};

export type MerchantOrderItem = {
	name: string;
	quantity: number;
	lineTotal: number;
	modifiers: MerchantModifier[];
};

export type MerchantOrder = {
	id: string;
	orderNumber: string;
	status: "pending" | "accepted";
	total: number;
	estimatedReadyAt: string;
	createdAt: string;
	customerName: string;
	customerPhone: string;
	customerNote: string | null;
	packagingPreference: "together" | "separate_spicy";
	specialOrder: boolean;
	items: MerchantOrderItem[];
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
		const deadlineDifference =
			new Date(left.estimatedReadyAt).getTime() - new Date(right.estimatedReadyAt).getTime();
		return deadlineDifference || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
	});
}
