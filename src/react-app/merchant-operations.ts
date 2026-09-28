export type MerchantModifier = {
	groupName: string;
	name: string;
};

export type MerchantOrderItem = {
	id?: string;
	menuItemId?: number;
	name: string;
	unitPrice?: number;
	quantity: number;
	lineTotal: number;
	modifiers: MerchantModifier[];
};

export type MerchantSpiceGroup = {
	name: string;
	className: "none" | "mild" | "small" | "medium" | "large" | "packet" | "other" | "unspecified";
	items: Array<MerchantOrderItem & { displayModifiers: MerchantModifier[] }>;
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

const SPICE_PRESENTATION: Record<string, { order: number; className: MerchantSpiceGroup["className"] }> = {
	"不辣": { order: 0, className: "none" },
	"微辣": { order: 1, className: "mild" },
	"小辣": { order: 2, className: "small" },
	"中辣": { order: 3, className: "medium" },
	"大辣": { order: 4, className: "large" },
	"辣粉另包": { order: 5, className: "packet" },
};

export function groupMerchantItemsBySpice(items: MerchantOrderItem[]): MerchantSpiceGroup[] {
	const groups = new Map<string, MerchantSpiceGroup>();
	for (const item of items) {
		const spice = item.modifiers.find((modifier) => modifier.groupName === "辣度");
		const name = spice?.name ?? "未指定辣度";
		const presentation = SPICE_PRESENTATION[name] ?? {
			order: spice ? 90 : 99,
			className: spice ? "other" as const : "unspecified" as const,
		};
		let group = groups.get(name);
		if (!group) {
			group = { name, className: presentation.className, items: [] };
			groups.set(name, group);
		}
		group.items.push({
			...item,
			displayModifiers: item.modifiers.filter((modifier) => modifier !== spice),
		});
	}

	return [...groups.values()].sort((left, right) => {
		const leftOrder = SPICE_PRESENTATION[left.name]?.order ?? (left.name === "未指定辣度" ? 99 : 90);
		const rightOrder = SPICE_PRESENTATION[right.name]?.order ?? (right.name === "未指定辣度" ? 99 : 90);
		return leftOrder - rightOrder || left.name.localeCompare(right.name, "zh-Hant");
	});
}
