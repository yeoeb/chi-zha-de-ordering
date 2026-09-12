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
