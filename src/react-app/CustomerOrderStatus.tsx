import { uiCopy } from "./ui-copy";
import { useEffect, useState } from "react";
import {
	CUSTOMER_STATUS_COPY,
	isCustomerOrderActive,
	shouldPollOrderStatus,
	type CustomerOrder,
} from "./order-status";
import { formatTaipeiDeadlineDateTime } from "./taipei-time";
import { formatTaipeiDeadlineTime } from "./taipei-time";
import {
	acknowledgeShortageRevision,
	readAcknowledgedShortageRevision,
	rememberActiveCustomerOrder,
} from "./active-customer-orders";
import { DestructiveConfirmationDialog } from "./DestructiveConfirmationDialog";
import { getCustomerHomeRoute } from "./return-navigation";

export const ORDER_STATUS_POLL_INTERVAL_MS = 4_000;

type CustomerOrderStatusProps = {
	publicLookupToken: string;
	initialOrder?: CustomerOrder;
	onBack?: () => void;
	backLabel?: string;
	onOrderChange?: (order: CustomerOrder) => void;
};

export default function CustomerOrderStatus({
	publicLookupToken,
	initialOrder,
	onBack,
	backLabel = uiCopy.customer.backToMenu,
	onOrderChange,
}: CustomerOrderStatusProps) {
	const [order, setOrder] = useState<CustomerOrder | null>(initialOrder ?? null);
	const [isLoading, setIsLoading] = useState(initialOrder === undefined);
	const [error, setError] = useState<"not-found" | "temporary" | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const [isCancelling, setIsCancelling] = useState(false);
	const [cancellationError, setCancellationError] = useState<string | null>(null);
	const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
	const [acknowledgedRevision, setAcknowledgedRevision] = useState(() => {
		try { return readAcknowledgedShortageRevision(publicLookupToken); } catch { return 0; }
	});

	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		let lastStatus = initialOrder?.status;
		let activeRequest: AbortController | undefined;

		async function loadOrder() {
			activeRequest = new AbortController();

			try {
				const response = await fetch(
					`/api/orders/by-token/${encodeURIComponent(publicLookupToken)}`,
					{
					signal: activeRequest.signal,
					cache: "no-store",
					},
				);

				if (response.status === 404) {
					if (!stopped) {
						setError("not-found");
						setIsLoading(false);
					}
					return;
				}

				if (!response.ok) {
					throw new Error("Order status request failed");
				}

				const result = (await response.json()) as { order: CustomerOrder };
				lastStatus = result.order.status;

				if (!stopped) {
					setOrder(result.order);
					setError(null);
					setIsLoading(false);
				}
			} catch (requestError: unknown) {
				if (
					!stopped &&
					!(requestError instanceof Error && requestError.name === "AbortError")
				) {
					setError("temporary");
					setIsLoading(false);
				}
			}

			if (!stopped && (lastStatus === undefined || shouldPollOrderStatus(lastStatus))) {
				timer = setTimeout(loadOrder, ORDER_STATUS_POLL_INTERVAL_MS);
			}
		}

		if (lastStatus === undefined) {
			void loadOrder();
		} else if (shouldPollOrderStatus(lastStatus)) {
			timer = setTimeout(loadOrder, ORDER_STATUS_POLL_INTERVAL_MS);
		}

		return () => {
			stopped = true;
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			activeRequest?.abort();
		};
	}, [initialOrder, publicLookupToken]);

	useEffect(() => {
		if (!order) return;
		try {
			rememberActiveCustomerOrder(order);
		} catch {
			// The status page remains usable when persistent browser storage is unavailable.
		}
		onOrderChange?.(order);
	}, [onOrderChange, order]);

	useEffect(() => {
		if (!order || order.orderSource === "onsite" || !shouldPollOrderStatus(order.status)) return;
		const updateNow = () => setNow(Date.now());
		const timer = window.setInterval(updateNow, 30_000);
		document.addEventListener("visibilitychange", updateNow);
		return () => {
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", updateNow);
		};
	}, [order]);

	async function cancelOrder() {
		if (!order || isCancelling) return;
		setIsCancelling(true);
		setCancellationError(null);
		try {
			const response = await fetch(`/api/orders/by-token/${encodeURIComponent(publicLookupToken)}/cancel`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirm: true }),
			});
			const result = await response.json() as { order?: CustomerOrder; error?: { code?: string } };
			if (!response.ok || !result.order) {
				const code = result.error?.code;
				setCancellationError(code === "CANCELLATION_DEADLINE_PASSED"
					? uiCopy.customer.cancelTooLate
					: code === "CANCELLATION_NOT_ALLOWED"
						? uiCopy.customer.cancelUnavailable
						: uiCopy.customer.cancelUnknown);
				return;
			}
			setOrder(result.order);
			setCancelDialogOpen(false);
		} catch {
			setCancellationError(uiCopy.customer.cancelUnknown);
		} finally {
			setIsCancelling(false);
		}
	}

	const isOnsite = order?.orderSource === "onsite";
	const deadlineReached = order ? !isCustomerOrderActive(order, now) && shouldPollOrderStatus(order.status) : false;
	const statusCopy = order
		? deadlineReached
			? { heading: uiCopy.customer.pickupTimeReached, detail: uiCopy.customer.pickupTimeReachedDetail }
			: isOnsite
				? {
					pending: { heading: uiCopy.customer.pending, detail: uiCopy.customer.orderSubmitted },
					accepted: { heading: uiCopy.customer.preparing, detail: uiCopy.customer.preparingDetail },
					completed: { heading: uiCopy.customer.completed, detail: uiCopy.customer.completedDetail },
					rejected: { heading: uiCopy.customer.rejected, detail: uiCopy.customer.rejectedDetail },
					cancelled: { heading: uiCopy.customer.cancelled, detail: uiCopy.onsite.cancelledDetail },
				}[order.status]
				: order.status === "rejected" && order.rejectionReason === "auto_rejected_unanswered"
					? { heading: uiCopy.customer.rejected, detail: uiCopy.customer.autoRejectedDetail }
					: CUSTOMER_STATUS_COPY[order.status]
		: null;
	const createdAt = order ? formatTaipeiDeadlineDateTime(order.createdAt) : null;
	const estimatedReadyAt = order ? formatTaipeiDeadlineTime(order.estimatedReadyAt) : null;
	const remainingMinutes = order && !isOnsite
		? Math.ceil((new Date(order.estimatedReadyAt).getTime() - now) / 60_000)
		: null;
	const shortageRevision = order?.shortageRevision ?? 0;
	const shortages = order?.shortages ?? [];
	const hasUnreadShortage = shortages.length > 0 && shortageRevision > acknowledgedRevision;

	return (
		<main className={`order-status-page${isOnsite ? " onsite-order-status" : ""}`}>
			<header className="order-status-header">
				<p className="eyebrow">{uiCopy.common.brand}</p>
				<h1>{isOnsite ? uiCopy.onsite.title : uiCopy.customer.orderProgress}</h1>
			</header>

			<button className="status-back-button" type="button" onClick={() => onBack ? onBack() : window.location.replace(getCustomerHomeRoute(isOnsite ? "onsite" : "online"))}>
				← {backLabel}
			</button>

			{isLoading && (
				<p className="status-message" role="status">
					{uiCopy.common.orderLoading}
				</p>
			)}
			{error === "not-found" && (
				<p className="status-message status-error" role="alert">
					{uiCopy.customer.orderNotFound}
				</p>
			)}
			{error === "temporary" && (
				<p className="status-message status-warning" role="status">
					{uiCopy.customer.orderSyncFailed}
				</p>
			)}

			{order && statusCopy && (
				<article className={`customer-order-status status-${order.status}`}>
					<section className="customer-pickup-time" aria-label={uiCopy.customer.pickupTime}>
						<span>{uiCopy.customer.pickup}</span>
						<strong>{estimatedReadyAt ?? uiCopy.common.notRecorded}</strong>
					</section>
					<h2>{statusCopy.heading}</h2>
					<p className="customer-status-detail">{statusCopy.detail}</p>

					{hasUnreadShortage && (
						<section className="customer-shortage-alert" role="alert">
							<h3>{uiCopy.customer.partialSoldOut}</h3>
							<strong>{uiCopy.customer.latestAmountPrefix} {order.total}</strong>
							<span>{uiCopy.customer.originalPricePrefix} {order.originalTotal ?? order.total}{uiCopy.customer.deductedAmountPrefix} {(order.originalTotal ?? order.total) - order.total}</span>
							<ul>{shortages.map((shortage, index) => <li key={`${shortage.name}-${index}`}>{shortage.name} × {shortage.quantity}</li>)}</ul>
							<button type="button" onClick={() => {
								try { acknowledgeShortageRevision(publicLookupToken, shortageRevision); } catch { /* keep in memory */ }
								setAcknowledgedRevision(shortageRevision);
							}}>{uiCopy.customer.acknowledge}</button>
						</section>
					)}
					{shortages.length > 0 && !hasUnreadShortage && (
						<section className="customer-shortage-record">
							<strong>{uiCopy.customer.adjustmentHistory}</strong>
							<span>{uiCopy.customer.originalAmountPrefix} {order.originalTotal ?? order.total}{uiCopy.customer.totalAmountPrefix} {order.total}</span>
						</section>
					)}

					<dl className="customer-status-meta">
						<div>
							<dt>{uiCopy.customer.createdTime}</dt>
							<dd>{createdAt ?? uiCopy.common.timeMissing}</dd>
						</div>
						{!isOnsite && <div>
							<dt>{uiCopy.customer.pickupTime}</dt>
							<dd>{estimatedReadyAt ?? uiCopy.common.readyTimeMissing}</dd>
						</div>}
					</dl>

					{isOnsite ? (
						<p className="onsite-pickup-message">
							{order.status === "completed"
								? uiCopy.customer.showOrderAtPickup
								: uiCopy.customer.pickupWhenReady}
						</p>
					) : (
						<p className="online-pickup-message">
							{uiCopy.customer.pickupTime} {estimatedReadyAt ?? uiCopy.common.notRecorded}{uiCopy.customer.pickupReferenceHint}
						</p>
					)}
					{!isOnsite && shouldPollOrderStatus(order.status) && remainingMinutes !== null && (
						<p className="pickup-countdown" role="status">
							{remainingMinutes > 10
								? `${uiCopy.customer.pickupRemainingPrefix}${remainingMinutes}${uiCopy.common.minutesSuffix}`
								: remainingMinutes > 0
									? `${uiCopy.customer.pickupSoonPrefix}${remainingMinutes}${uiCopy.common.minutesSuffix}`
									: uiCopy.customer.pickupTimeReachedHint}
						</p>
					)}

					{order.customerNote && (
						<p className="customer-order-note">
							<strong>{uiCopy.common.orderNote}</strong>
							<span>{order.customerNote}</span>
						</p>
					)}
					{order.packagingPreference === "separate_spicy" && (
						<p className="customer-order-note">
							<strong>{uiCopy.common.packaging}</strong>
							<span>{uiCopy.common.separateSpicyBags}</span>
						</p>
					)}

					<ul className="customer-status-items">
						{order.items.map((item, index) => (
							<li key={`${order.publicLookupToken}-${index}`}>
								<div>
									<strong>
										{item.name} × {item.quantity}
									</strong>
									{item.modifiers.length > 0 && (
										<p>{item.modifiers.map((modifier) => modifier.name).join(" / ")}</p>
									)}
								</div>
								<span>NT$ {item.lineTotal}</span>
							</li>
						))}
					</ul>

					<p className="customer-status-total">
						<span>{order.cancelledAt ? uiCopy.customer.currentAmount : uiCopy.customer.total}</span>
						<strong>NT$ {order.total}</strong>
					</p>

					{order.status === "pending" && !deadlineReached && (
						<button className="customer-cancel-order" type="button" disabled={isCancelling} onClick={() => setCancelDialogOpen(true)}>
							{isCancelling ? uiCopy.customer.cancelling : uiCopy.customer.cancelOrder}
						</button>
					)}
					{order.status === "accepted" && <p className="cancellation-guidance">{uiCopy.customer.acceptedCancelHint}</p>}
					{cancellationError && <p className="message error" role="alert">{cancellationError}</p>}

					{isCustomerOrderActive(order, now) && (
						<p className="polling-note" role="status">
							{uiCopy.customer.autoRefreshHint}
						</p>
					)}
				</article>
			)}
			{cancelDialogOpen && order?.status === "pending" && (
				<DestructiveConfirmationDialog
					title={uiCopy.customer.cancelTitle}
					description={uiCopy.customer.cancelDescription}
					dismissLabel={uiCopy.customer.cancelDismiss}
					confirmLabel={uiCopy.customer.cancelOrder}
					isProcessing={isCancelling}
					onDismiss={() => setCancelDialogOpen(false)}
					onConfirm={() => void cancelOrder()}
				>
					<p className="merchant-dialog-summary">{uiCopy.customer.pickup} {estimatedReadyAt ?? uiCopy.common.timeMissing}</p>
				</DestructiveConfirmationDialog>
			)}
		</main>
	);
}
