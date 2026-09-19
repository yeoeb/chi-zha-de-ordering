import { useEffect, useState } from "react";
import {
	CUSTOMER_STATUS_COPY,
	shouldPollOrderStatus,
	type CustomerOrder,
} from "./order-status";

export const ORDER_STATUS_POLL_INTERVAL_MS = 4_000;

function formatDateTime(timestamp: string) {
	return new Intl.DateTimeFormat("zh-TW", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(timestamp));
}

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

	const statusCopy = order ? CUSTOMER_STATUS_COPY[order.status] : null;

	return (
		<main className="order-status-page">
			<header className="order-status-header">
				<p className="eyebrow">吃炸的</p>
				<h1>訂單狀態</h1>
			</header>

			<button className="status-back-button" type="button" onClick={() => window.location.assign("/")}>
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

					<dl className="customer-status-meta">
						<div>
							<dt>顧客</dt>
							<dd>{order.customerName}</dd>
						</div>
						<div>
							<dt>送出時間</dt>
							<dd>{formatDateTime(order.createdAt)}</dd>
						</div>
						<div>
							<dt>預計完成時間</dt>
							<dd>{formatDateTime(order.estimatedReadyAt)}</dd>
						</div>
					</dl>

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
						<span>總計</span>
						<strong>NT$ {order.total}</strong>
					</p>

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
