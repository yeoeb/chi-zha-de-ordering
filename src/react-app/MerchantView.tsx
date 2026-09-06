import { useEffect, useState } from "react";

type MerchantOrder = {
	id: string;
	orderNumber: string;
	status: "pending" | "accepted";
	total: number;
	estimatedReadyAt: string;
	createdAt: string;
	customerName: string;
	customerPhone: string;
	specialOrder: boolean;
	items: Array<{
		name: string;
		quantity: number;
		lineTotal: number;
		modifiers: Array<{ name: string }>;
	}>;
};

type MerchantOrdersResponse = {
	orders: MerchantOrder[];
};

type MerchantAction = "accept" | "reject" | "complete";

function formatDateTime(timestamp: string) {
	return new Intl.DateTimeFormat("zh-TW", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(timestamp));
}

export default function MerchantView() {
	const [orders, setOrders] = useState<MerchantOrder[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [processingOrderId, setProcessingOrderId] = useState<string | null>(null);
	const [refreshVersion, setRefreshVersion] = useState(0);

	useEffect(() => {
		const controller = new AbortController();
		setIsLoading(true);
		setError(null);

		fetch("/api/merchant/orders", { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) {
					throw new Error("Merchant Orders request failed");
				}

				return response.json() as Promise<MerchantOrdersResponse>;
			})
			.then((result) => setOrders(result.orders))
			.catch((requestError: unknown) => {
				if (!(requestError instanceof Error && requestError.name === "AbortError")) {
					setError("目前無法載入訂單，請稍後再試。");
				}
			})
			.finally(() => {
				if (!controller.signal.aborted) {
					setIsLoading(false);
				}
			});

		return () => controller.abort();
	}, [refreshVersion]);

	async function performAction(orderId: string, action: MerchantAction) {
		setProcessingOrderId(orderId);
		setError(null);

		try {
			const response = await fetch(`/api/merchant/orders/${encodeURIComponent(orderId)}/${action}`, {
				method: "POST",
			});

			if (!response.ok) {
				throw new Error("Merchant Order action failed");
			}

			setRefreshVersion((current) => current + 1);
		} catch {
			setError("訂單狀態可能已被更新，請重新整理後再試。");
		} finally {
			setProcessingOrderId(null);
		}
	}

	return (
		<main className="merchant-page">
			<header className="merchant-header">
				<p className="eyebrow">吃炸的</p>
				<h1>店家訂單</h1>
				<p>依送單時間排列，先處理最早的訂單。</p>
			</header>

			<p className="merchant-security-note">本頁僅供本機開發使用，目前尚未加入店家身分驗證。</p>

			{error && (
				<p className="merchant-message merchant-error" role="alert">
					{error}
				</p>
			)}
			{isLoading && (
				<p className="merchant-message" role="status">
					訂單載入中…
				</p>
			)}
			{!isLoading && orders.length === 0 && (
				<p className="merchant-message">目前沒有待處理訂單。</p>
			)}

			<section className="merchant-orders" aria-label="待處理訂單">
				{orders.map((order) => {
					const isProcessing = processingOrderId === order.id;

					return (
						<article className={`merchant-order ${order.specialOrder ? "special" : ""}`} key={order.id}>
							<div className="merchant-order-heading">
								<div>
									<p className="merchant-order-number">訂單 #{order.orderNumber}</p>
									<h2>{order.status === "pending" ? "等待店家確認" : "店家已接受"}</h2>
								</div>
								{order.specialOrder && <span className="special-badge">特殊訂單</span>}
							</div>

							<dl className="merchant-order-meta">
								<div>
									<dt>顧客</dt>
									<dd>{order.customerName}</dd>
								</div>
								<div>
									<dt>電話</dt>
									<dd>{order.customerPhone}</dd>
								</div>
								<div>
									<dt>送出時間</dt>
									<dd>{formatDateTime(order.createdAt)}</dd>
								</div>
								<div>
									<dt>預計完成</dt>
									<dd>{formatDateTime(order.estimatedReadyAt)}</dd>
								</div>
							</dl>

							<ul className="merchant-item-list">
								{order.items.map((item, index) => (
									<li key={`${order.id}-${index}`}>
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

							<p className="merchant-order-total">
								<span>總額</span>
								<strong>NT$ {order.total}</strong>
							</p>

							<div className="merchant-actions">
								{order.status === "pending" ? (
									<>
										<button
											type="button"
											disabled={isProcessing}
											onClick={() => performAction(order.id, "accept")}
										>
											接受
										</button>
										<button
											className="reject-button"
											type="button"
											disabled={isProcessing}
											onClick={() => performAction(order.id, "reject")}
										>
											拒絕
										</button>
									</>
								) : (
									<button
										type="button"
										disabled={isProcessing}
										onClick={() => performAction(order.id, "complete")}
									>
										完成
									</button>
								)}
							</div>
						</article>
					);
				})}
			</section>
		</main>
	);
}
