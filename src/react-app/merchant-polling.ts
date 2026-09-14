export type PollingOrder = {
	id: string;
	status: "pending" | "accepted";
};

export function findNewPendingOrderIds(
	seenOrderIds: ReadonlySet<string>,
	orders: ReadonlyArray<PollingOrder>,
	hasCompletedInitialLoad: boolean,
) {
	if (!hasCompletedInitialLoad) {
		return [];
	}

	return orders
		.filter((order) => order.status === "pending" && !seenOrderIds.has(order.id))
		.map((order) => order.id);
}

export type RevisionedStoreSnapshot = {
	is_accepting_orders: boolean;
	stateVersion: number;
};

export function selectNewestStoreSnapshot<T extends RevisionedStoreSnapshot>(
	current: T | null,
	candidate: T,
) {
	return current && current.stateVersion > candidate.stateVersion ? current : candidate;
}
