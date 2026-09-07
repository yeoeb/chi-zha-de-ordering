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

type StoreSettings = {
	display_name: string;
	is_accepting_orders: boolean;
};

type MerchantMenuItem = {
	id: number;
	name: string;
	isAvailable: boolean;
};

type MenuResponse = {
	categories: Array<{ items: MerchantMenuItem[] }>;
};

type MerchantAction = "accept" | "reject" | "complete";

const MERCHANT_REFRESH_INTERVAL_MS = 5_000;

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
	const [store, setStore] = useState<StoreSettings | null>(null);
	const [menuItems, setMenuItems] = useState<MerchantMenuItem[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [processingControl, setProcessingControl] = useState<string | null>(null);
	const [refreshVersion, setRefreshVersion] = useState(0);

	useEffect(() => {
		const controller = new AbortController();
		let pollTimeout: number | undefined;
		setIsLoading(true);
		setError(null);

		async function loadMerchantData() {
			try {
				const [ordersResponse, storeResponse, menuResponse] = await Promise.all([
					fetch("/api/merchant/orders", { signal: controller.signal, cache: "no-store" }),
					fetch("/api/store", { signal: controller.signal, cache: "no-store" }),
					fetch("/api/menu", { signal: controller.signal, cache: "no-store" }),
				]);

				if (!ordersResponse.ok || !storeResponse.ok || !menuResponse.ok) {
					throw new Error("Merchant data request failed");
				}

				const [ordersResult, storeResult, menuResult] = await Promise.all([
					ordersResponse.json() as Promise<MerchantOrdersResponse>,
					storeResponse.json() as Promise<StoreSettings>,
					menuResponse.json() as Promise<MenuResponse>,
				]);

				setOrders(ordersResult.orders);
				setStore(storeResult);
				setMenuItems(menuResult.categories.flatMap((category) => category.items));
				setError(null);
			} catch (requestError) {
				if (!(requestError instanceof Error && requestError.name === "AbortError")) {
					setError("目前無法載入訂單，請稍後再試。");
				}
			} finally {
				if (!controller.signal.aborted) {
					setIsLoading(false);
					pollTimeout = window.setTimeout(loadMerchantData, MERCHANT_REFRESH_INTERVAL_MS);
				}
			}
		}

		void loadMerchantData();

		return () => {
			controller.abort();
			if (pollTimeout !== undefined) {
				window.clearTimeout(pollTimeout);
			}
		};
	}, [refreshVersion]);

	async function performAction(orderId: string, action: MerchantAction) {
		setProcessingControl(`order-${orderId}`);
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
			setProcessingControl(null);
		}
	}

	async function performAvailabilityAction(controlKey: string, endpoint: string) {
		setProcessingControl(controlKey);
		setError(null);

		try {
			const response = await fetch(endpoint, { method: "POST" });

			if (!response.ok) {
				throw new Error("Availability action failed");
			}

			setRefreshVersion((current) => current + 1);
		} catch {
			setError("營運狀態更新失敗，請稍後再試。");
		} finally {
			setProcessingControl(null);
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

			{store && (
				<section className="merchant-controls" aria-labelledby="operations-heading">
					<h2 id="operations-heading">營運控制</h2>

					<div className="store-control">
						<div>
							<h3>接單狀態</h3>
							<strong className={store.is_accepting_orders ? "accepting" : "paused"}>
								{store.is_accepting_orders ? "接單中" : "暫停接單"}
							</strong>
						</div>
						<button
							type="button"
							disabled={processingControl !== null}
							onClick={() =>
								performAvailabilityAction(
									"store",
									store.is_accepting_orders
										? "/api/merchant/store/pause"
										: "/api/merchant/store/resume",
								)
							}
						>
							{store.is_accepting_orders ? "暫停接單" : "恢復接單"}
						</button>
					</div>

					<h3 className="item-controls-heading">商品狀態</h3>
					<ul className="item-controls">
						{menuItems.map((item) => (
							<li key={item.id}>
								<div>
									<strong>{item.name}</strong>
									<span className={item.isAvailable ? "available" : "sold-out"}>
										{item.isAvailable ? "販售中" : "售完"}
									</span>
								</div>
								<button
									type="button"
									disabled={processingControl !== null}
									onClick={() =>
										performAvailabilityAction(
											`item-${item.id}`,
											`/api/merchant/menu-items/${item.id}/${item.isAvailable ? "sold-out" : "restore"}`,
										)
									}
								>
									{item.isAvailable ? "標記售完" : "恢復販售"}
								</button>
							</li>
						))}
					</ul>
				</section>
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
					const isProcessing = processingControl === `order-${order.id}`;

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
