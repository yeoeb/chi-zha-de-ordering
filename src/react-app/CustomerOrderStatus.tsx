import { useEffect, useState } from "react";
import {
	CUSTOMER_STATUS_COPY,
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

export const ORDER_STATUS_POLL_INTERVAL_MS = 4_000;

type CustomerOrderStatusProps = {
	publicLookupToken: string;
	initialOrder?: CustomerOrder;
};

export default function CustomerOrderStatus({
	publicLookupToken,
	initialOrder,
}: CustomerOrderStatusProps) {
	const [order, setOrder] = useState<CustomerOrder | null>(initialOrder ?? null);
	const [isLoading, setIsLoading] = useState(initialOrder === undefined);
	const [error, setError] = useState<"not-found" | "temporary" | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const [isCancelling, setIsCancelling] = useState(false);
	const [cancellationError, setCancellationError] = useState<string | null>(null);
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
	}, [order]);

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
		if (!order || isCancelling || !window.confirm("確定取消這筆訂單？取消後無法恢復。")) return;
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
					? "已進入取餐前 10 分鐘，無法線上取消，請直接聯絡店家。"
					: code === "CANCELLATION_NOT_ALLOWED"
						? "店家已接單或訂單已結束，無法線上自行取消，請聯絡店家。"
						: "取消結果尚未確認，請稍後重新查看訂單狀態。");
				return;
			}
			setOrder(result.order);
		} catch {
			setCancellationError("取消結果尚未確認，請稍後重新查看訂單狀態。");
		} finally {
			setIsCancelling(false);
		}
	}

	const isOnsite = order?.orderSource === "onsite";
	const statusCopy = order
		? isOnsite
			? {
				pending: { heading: "等待店家接單", detail: "訂單已送出" },
				accepted: { heading: "製作中", detail: "正在製作，請稍候" },
				completed: { heading: "餐點已完成", detail: "可以取餐了" },
				rejected: { heading: "訂單未成立", detail: "店家未接受這筆訂單" },
				cancelled: { heading: "訂單已取消", detail: "這筆現場訂單不會繼續製作" },
			}[order.status]
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
				<p className="eyebrow">吃炸的</p>
				<h1>{isOnsite ? "現場點餐" : "訂單進度"}</h1>
			</header>

			<button className="status-back-button" type="button" onClick={() => window.location.assign(isOnsite ? "/onsite" : "/")}>
				← 返回菜單
			</button>

			{isLoading && (
				<p className="status-message" role="status">
					訂單載入中…
				</p>
			)}
			{error === "not-found" && (
				<p className="status-message status-error" role="alert">
					找不到這筆訂單，請確認連結是否正確。
				</p>
			)}
			{error === "temporary" && (
				<p className="status-message status-warning" role="status">
					暫時無法更新訂單狀態，系統會稍後再試。已顯示的訂單內容不會消失。
				</p>
			)}

			{order && statusCopy && (
				<article className={`customer-order-status status-${order.status}`}>
					<p className="customer-order-number">訂單 #{order.orderNumber}</p>
					<h2>{statusCopy.heading}</h2>
					<p className="customer-status-detail">{statusCopy.detail}</p>

					{hasUnreadShortage && (
						<section className="customer-shortage-alert" role="alert">
							<h3>部分餐點已售完</h3>
							<strong>最新應付金額 NT$ {order.total}</strong>
							<span>原價 NT$ {order.originalTotal ?? order.total}，已扣除 NT$ {(order.originalTotal ?? order.total) - order.total}</span>
							<ul>{shortages.map((shortage, index) => <li key={`${shortage.name}-${index}`}>{shortage.name} × {shortage.quantity}</li>)}</ul>
							<button type="button" onClick={() => {
								try { acknowledgeShortageRevision(publicLookupToken, shortageRevision); } catch { /* keep in memory */ }
								setAcknowledgedRevision(shortageRevision);
							}}>我知道了</button>
						</section>
					)}
					{shortages.length > 0 && !hasUnreadShortage && (
						<section className="customer-shortage-record">
							<strong>餐點調整紀錄</strong>
							<span>原始 NT$ {order.originalTotal ?? order.total}・總金額 NT$ {order.total}</span>
						</section>
					)}

					<dl className="customer-status-meta">
						{!isOnsite && <div>
							<dt>顧客</dt>
							<dd>{order.customerName}</dd>
						</div>}
						<div>
							<dt>送出時間</dt>
							<dd>{createdAt ?? "時間未記錄"}</dd>
						</div>
						{!isOnsite && <div>
							<dt>預計取餐時間</dt>
							<dd>{estimatedReadyAt ?? "預計完成時間未記錄"}</dd>
						</div>}
					</dl>

					{isOnsite ? (
						<p className="onsite-pickup-message">
							{order.status === "completed"
								? "請向店家出示此訂單畫面"
								: "餐點完成後即可取餐"}
						</p>
					) : (
						<p className="online-pickup-message">
							預計取餐時間 {estimatedReadyAt ?? "尚未記錄"}；取餐時請向店家報此時間。
						</p>
					)}
					{!isOnsite && shouldPollOrderStatus(order.status) && remainingMinutes !== null && (
						<p className="pickup-countdown" role="status">
							{remainingMinutes > 10
								? `距離預計取餐還有 ${remainingMinutes} 分鐘`
								: remainingMinutes > 0
									? `即將可以取餐，約剩 ${remainingMinutes} 分鐘`
									: "已到預計取餐時間，請查看目前訂單狀態。"}
						</p>
					)}

					{order.customerNote && (
						<p className="customer-order-note">
							<strong>訂單備註</strong>
							<span>{order.customerNote}</span>
						</p>
					)}
					{order.packagingPreference === "separate_spicy" && (
						<p className="customer-order-note">
							<strong>包裝方式</strong>
							<span>辣／不辣分袋</span>
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
						<span>{order.cancelledAt ? "目前應付" : "總計"}</span>
						<strong>NT$ {order.total}</strong>
					</p>

					{order.status === "pending" && (
						<button className="customer-cancel-order" type="button" disabled={isCancelling} onClick={() => void cancelOrder()}>
							{isCancelling ? "取消處理中…" : "取消訂單"}
						</button>
					)}
					{order.status === "accepted" && <p className="cancellation-guidance">店家已接單，無法線上自行取消；如有需要請直接聯絡店家。</p>}
					{cancellationError && <p className="message error" role="alert">{cancellationError}</p>}

					{shouldPollOrderStatus(order.status) && (
						<p className="polling-note" role="status">
							狀態會自動更新，不需要重新整理頁面。
						</p>
					)}
				</article>
			)}
		</main>
	);
}
