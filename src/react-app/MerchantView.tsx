import { useEffect, useRef, useState } from "react";
import { findNewPendingOrderIds, selectNewestStoreSnapshot } from "./merchant-polling";

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

type MerchantNotification = {
	id: string;
	orderNumber: string;
	channel: "line" | "web_push";
	eventType: "new_order";
	status: "pending" | "sent" | "failed";
	attemptCount: number;
	lastAttemptAt: string | null;
	sentAt: string | null;
	lastError: string | null;
	createdAt: string;
};

type MerchantNotificationsResponse = {
	deliveries: MerchantNotification[];
};

type StoreSettings = {
	display_name: string;
	is_accepting_orders: boolean;
	stateVersion: number;
};

type StoreOperationResult = {
	operationId: string;
	action: "pause" | "resume";
	outcome: "APPLIED" | "IDEMPOTENT_REPLAY" | "ALREADY_IN_TARGET_STATE" | "STALE_STATE";
	store: { is_accepting_orders: boolean };
	stateVersion: number;
	createdAt: string;
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

class ConclusiveStoreOperationError extends Error {}

type PushState = "checking" | "unsupported" | "default" | "denied" | "enabled" | "disabled";

function supportsWebPush() {
	return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function base64UrlToUint8Array(value: string) {
	const padding = "=".repeat((4 - (value.length % 4)) % 4);
	const decoded = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function playNewOrderAlert() {
	if (!("AudioContext" in window)) return;

	try {
		const context = new AudioContext();
		const oscillator = context.createOscillator();
		const gain = context.createGain();
		oscillator.frequency.value = 880;
		gain.gain.setValueAtTime(0.0001, context.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.45);
		oscillator.connect(gain);
		gain.connect(context.destination);
		oscillator.start();
		oscillator.stop(context.currentTime + 0.45);
		oscillator.addEventListener("ended", () => void context.close());
		if (context.state === "suspended") void context.resume().catch(() => context.close());
	} catch {
		// Browser autoplay policy can block sound; polling and visual highlighting still continue.
	}
}

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
	const [notifications, setNotifications] = useState<MerchantNotification[]>([]);
	const [store, setStore] = useState<StoreSettings | null>(null);
	const [menuItems, setMenuItems] = useState<MerchantMenuItem[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [processingControl, setProcessingControl] = useState<string | null>(null);
	const [storeMutationInFlight, setStoreMutationInFlight] = useState(false);
	const [merchantAccessHealthy, setMerchantAccessHealthy] = useState(false);
	const [lastStoreOperation, setLastStoreOperation] = useState<StoreOperationResult | null>(null);
	const [refreshVersion, setRefreshVersion] = useState(0);
	const [isOnline, setIsOnline] = useState(() => navigator.onLine);
	const [pushState, setPushState] = useState<PushState>("checking");
	const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
	const [newOrderIds, setNewOrderIds] = useState<Set<string>>(() => new Set());
	const seenOrderIds = useRef(new Set<string>());
	const hasCompletedInitialLoad = useRef(false);
	const storeMutationInFlightRef = useRef(false);
	const storeEpoch = useRef(0);
	const newestStoreVersion = useRef(-1);

	function applyStoreSnapshot(candidate: StoreSettings, epoch = storeEpoch.current) {
		if (epoch !== storeEpoch.current || candidate.stateVersion < newestStoreVersion.current) {
			return false;
		}
		newestStoreVersion.current = candidate.stateVersion;
		setStore((current) => selectNewestStoreSnapshot(current, candidate));
		return true;
	}

	function parseStoreSettings(value: unknown): StoreSettings {
		if (
			typeof value !== "object" ||
			value === null ||
			!("display_name" in value) ||
			typeof value.display_name !== "string" ||
			!("is_accepting_orders" in value) ||
			typeof value.is_accepting_orders !== "boolean" ||
			!("stateVersion" in value) ||
			typeof value.stateVersion !== "number" ||
			!Number.isSafeInteger(value.stateVersion) ||
			value.stateVersion < 0
		) {
			throw new Error("Store state response is invalid");
		}
		return value as StoreSettings;
	}

	async function fetchAuthoritativeStore() {
		const response = await fetch("/api/store", { cache: "no-store" });
		if (!response.ok) throw new Error("Store state request failed");
		return parseStoreSettings(await response.json());
	}

	useEffect(() => {
		const markOnline = () => setIsOnline(true);
		const markOffline = () => setIsOnline(false);
		window.addEventListener("online", markOnline);
		window.addEventListener("offline", markOffline);
		return () => {
			window.removeEventListener("online", markOnline);
			window.removeEventListener("offline", markOffline);
		};
	}, []);

	useEffect(() => {
		let active = true;
		async function inspectPushState() {
			if (!supportsWebPush()) {
				setPushState("unsupported");
				return;
			}

			if (Notification.permission === "denied") {
				setPushState("denied");
				return;
			}

			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.getSubscription();
			if (active) {
				setPushState(
					subscription
						? "enabled"
						: Notification.permission === "default"
							? "default"
							: "disabled",
				);
			}
		}

		void inspectPushState().catch(() => {
			if (active) setPushState("disabled");
		});
		return () => {
			active = false;
		};
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		let pollTimeout: number | undefined;
		setIsLoading(true);
		setError(null);

		async function loadMerchantData() {
			const requestEpoch = storeEpoch.current;
			try {
				const [ordersResponse, notificationsResponse, storeResponse, menuResponse] = await Promise.all([
					fetch("/api/merchant/orders", { signal: controller.signal, cache: "no-store" }),
					fetch("/api/merchant/notifications", {
						signal: controller.signal,
						cache: "no-store",
					}),
					fetch("/api/store", { signal: controller.signal, cache: "no-store" }),
					fetch("/api/menu", { signal: controller.signal, cache: "no-store" }),
				]);

				if (
					!ordersResponse.ok ||
					!notificationsResponse.ok ||
					!storeResponse.ok ||
					!menuResponse.ok
				) {
					throw new Error("Merchant data request failed");
				}

				const [ordersResult, notificationsResult, storeResult, menuResult] = await Promise.all([
					ordersResponse.json() as Promise<MerchantOrdersResponse>,
					notificationsResponse.json() as Promise<MerchantNotificationsResponse>,
					storeResponse.json() as Promise<StoreSettings>,
					menuResponse.json() as Promise<MenuResponse>,
				]);

				const discovered = findNewPendingOrderIds(
					seenOrderIds.current,
					ordersResult.orders,
					hasCompletedInitialLoad.current,
				);
				for (const order of ordersResult.orders) seenOrderIds.current.add(order.id);
				hasCompletedInitialLoad.current = true;
				if (discovered.length > 0) {
					setNewOrderIds((current) => new Set([...current, ...discovered]));
					playNewOrderAlert();
				}
				setOrders(ordersResult.orders);
				setNotifications(notificationsResult.deliveries);
				applyStoreSnapshot(parseStoreSettings(storeResult), requestEpoch);
				setMenuItems(menuResult.categories.flatMap((category) => category.items));
				setLastSyncAt(new Date());
				setMerchantAccessHealthy(true);
				setError(null);
			} catch (requestError) {
				if (!(requestError instanceof Error && requestError.name === "AbortError")) {
					setMerchantAccessHealthy(false);
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

			setNewOrderIds((current) => {
				const next = new Set(current);
				next.delete(orderId);
				return next;
			});
			setRefreshVersion((current) => current + 1);
		} catch {
			setError("訂單狀態可能已被更新，請重新整理後再試。");
		} finally {
			setProcessingControl(null);
		}
	}

	async function enablePushNotifications() {
		setProcessingControl("push");
		setError(null);
		try {
			if (!supportsWebPush()) {
				setPushState("unsupported");
				return;
			}

			const permission = await Notification.requestPermission();
			if (permission !== "granted") {
				setPushState(permission);
				return;
			}

			const keyResponse = await fetch("/api/merchant/push/public-key", { cache: "no-store" });
			if (!keyResponse.ok) throw new Error("Web Push public key unavailable");
			const { publicKey } = (await keyResponse.json()) as { publicKey: string };
			const registration = await navigator.serviceWorker.ready;
			const existing = await registration.pushManager.getSubscription();
			const subscription =
				existing ??
				(await registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: base64UrlToUint8Array(publicKey),
				}));
			const saveResponse = await fetch("/api/merchant/push/subscriptions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(subscription.toJSON()),
			});
			if (!saveResponse.ok) {
				if (!existing) await subscription.unsubscribe();
				throw new Error("Web Push subscription could not be saved");
			}
			setPushState("enabled");
		} catch {
			setError("通知開啟失敗，請確認網路與瀏覽器設定後再試。");
			setPushState("disabled");
		} finally {
			setProcessingControl(null);
		}
	}

	async function disablePushNotifications() {
		setProcessingControl("push");
		setError(null);
		try {
			if (!supportsWebPush()) return;
			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.getSubscription();
			if (subscription) {
				const response = await fetch("/api/merchant/push/subscriptions", {
					method: "DELETE",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ endpoint: subscription.endpoint }),
				});
				if (!response.ok) throw new Error("Web Push subscription could not be removed");
				await subscription.unsubscribe();
			}
			setPushState("disabled");
		} catch {
			setError("通知停用失敗，請稍後再試。");
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

	async function readStoreOperation(operationId: string) {
		const response = await fetch(
			`/api/merchant/store/operations/${encodeURIComponent(operationId)}`,
			{ cache: "no-store" },
		);
		if (response.status === 404) return null;
		if (!response.ok) throw new Error("Store operation lookup failed");
		return parseStoreOperationResult(await response.json(), operationId, "pause");
	}

	function parseStoreOperationResult(
		value: unknown,
		operationId: string,
		action: "pause" | "resume",
	): StoreOperationResult {
		if (
			typeof value !== "object" ||
			value === null ||
			!("operationId" in value) ||
			value.operationId !== operationId ||
			!("action" in value) ||
			value.action !== action ||
			!("outcome" in value) ||
			!["APPLIED", "IDEMPOTENT_REPLAY", "ALREADY_IN_TARGET_STATE", "STALE_STATE"].includes(
				String(value.outcome),
			) ||
			!("store" in value) ||
			typeof value.store !== "object" ||
			value.store === null ||
			!("is_accepting_orders" in value.store) ||
			typeof value.store.is_accepting_orders !== "boolean" ||
			!("stateVersion" in value) ||
			typeof value.stateVersion !== "number" ||
			!Number.isSafeInteger(value.stateVersion) ||
			value.stateVersion < 0 ||
			!("createdAt" in value) ||
			typeof value.createdAt !== "string"
		) {
			throw new Error("Store operation response was invalid");
		}
		return value as StoreOperationResult;
	}

	async function postStoreOperation(
		action: "pause" | "resume",
		operationId: string,
		expected: StoreSettings,
	) {
		const response = await fetch(`/api/merchant/store/${action}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				operationId,
				expectedIsAcceptingOrders: action === "pause",
				expectedStateVersion: expected.stateVersion,
			}),
		});
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new Error("Store operation response was not conclusive");
		}
		if ([400, 403].includes(response.status)) {
			throw new ConclusiveStoreOperationError("Store operation was denied");
		}
		if (
			response.status === 409 &&
			typeof body === "object" &&
			body !== null &&
			"error" in body
		) {
			throw new ConclusiveStoreOperationError("Store operation conflicted");
		}
		if (![200, 409].includes(response.status)) {
			throw new Error("Store operation response was not conclusive");
		}
		return parseStoreOperationResult(body, operationId, action);
	}

	function applyOperationResult(result: StoreOperationResult) {
		setLastStoreOperation(result);
	}

	async function refreshStoreAfterOperation() {
		const authoritative = await fetchAuthoritativeStore();
		if (!applyStoreSnapshot(authoritative)) {
			throw new Error("Store state response was stale");
		}
		setLastSyncAt(new Date());
		return authoritative;
	}

	async function recoverAmbiguousPause(operationId: string, expected: StoreSettings) {
		const existing = await readStoreOperation(operationId);
		if (existing) {
			if (existing.action !== "pause") throw new Error("Store operation ID conflict");
			applyOperationResult(existing);
			await refreshStoreAfterOperation();
			return;
		}

		const authoritative = await refreshStoreAfterOperation();
		if (!authoritative.is_accepting_orders) return;
		const replay = await postStoreOperation("pause", operationId, expected);
		applyOperationResult(replay);
		await refreshStoreAfterOperation();
	}

	async function pauseStore() {
		if (storeMutationInFlightRef.current || !store?.is_accepting_orders) return;
		storeMutationInFlightRef.current = true;
		setStoreMutationInFlight(true);
		setError(null);
		storeEpoch.current += 1;
		const expected = store;
		const operationId = crypto.randomUUID();

		try {
			try {
				const result = await postStoreOperation("pause", operationId, expected);
				applyOperationResult(result);
				await refreshStoreAfterOperation();
			} catch (operationError) {
				if (operationError instanceof ConclusiveStoreOperationError) throw operationError;
				await recoverAmbiguousPause(operationId, expected);
			}
		} catch {
			setError("暫停接單結果不明，請查看最新店家狀態；系統不會建立新的操作編號。");
		} finally {
			storeMutationInFlightRef.current = false;
			setStoreMutationInFlight(false);
		}
	}

	async function resumeStore() {
		if (storeMutationInFlightRef.current || !merchantAccessHealthy) return;
		storeMutationInFlightRef.current = true;
		setStoreMutationInFlight(true);
		setError(null);
		storeEpoch.current += 1;

		try {
			const fresh = await fetchAuthoritativeStore();
			if (!applyStoreSnapshot(fresh)) throw new Error("Store state response was stale");
			const freshSyncAt = new Date();
			setLastSyncAt(freshSyncAt);
			if (fresh.is_accepting_orders) return;
			const lastSync = formatDateTime(freshSyncAt.toISOString());
			const confirmed = window.confirm(
				`即將公開接受真人訂單。\n目前狀態：暫停接單\n最後同步：${lastSync}\n需要停止時，請立即使用「暫停接單」。`,
			);
			if (!confirmed) return;

			const operationId = crypto.randomUUID();
			const result = await postStoreOperation("resume", operationId, fresh);
			applyOperationResult(result);
			await refreshStoreAfterOperation();
		} catch {
			setError("無法安全確認接單狀態，恢復接單已停止。請重新登入並重新同步。");
			setMerchantAccessHealthy(false);
		} finally {
			storeMutationInFlightRef.current = false;
			setStoreMutationInFlight(false);
		}
	}

	async function retryNotification(deliveryId: string) {
		setProcessingControl(`notification-${deliveryId}`);
		setError(null);

		try {
			const response = await fetch(
				`/api/merchant/notifications/${encodeURIComponent(deliveryId)}/retry`,
				{ method: "POST" },
			);

			if (!response.ok) {
				throw new Error("Notification retry failed");
			}

			setRefreshVersion((current) => current + 1);
		} catch {
			setError("通知重新傳送失敗，請查看通知狀態後再試。");
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

			<p className="merchant-security-note">店家管理頁已啟用身分驗證。</p>

			<section className="merchant-connection-status" aria-label="系統狀態">
				<div>
					<span className={isOnline ? "status-dot online" : "status-dot offline"} />
					<strong>{isOnline ? "Online" : "Offline"}</strong>
				</div>
				<div>
					<strong>
						通知
						{pushState === "enabled"
							? "已開啟"
							: pushState === "checking"
								? "確認中"
								: "未開啟"}
					</strong>
					<button
						type="button"
						disabled={processingControl !== null || pushState === "checking"}
						onClick={() =>
							pushState === "enabled"
								? void disablePushNotifications()
								: void enablePushNotifications()
						}
					>
						{pushState === "enabled" ? "停用通知" : "開啟通知"}
					</button>
				</div>
				<small>
					上次同步：{lastSyncAt ? formatDateTime(lastSyncAt.toISOString()) : "尚未同步"}
				</small>
				{pushState === "unsupported" && (
					<p>此開啟方式尚不支援通知。請先將店家頁加入主畫面，再從主畫面開啟。</p>
				)}
				{pushState === "denied" && <p>通知已被瀏覽器拒絕，請從系統設定重新允許。</p>}
			</section>

			{error && (
				<p className="merchant-message merchant-error" role="alert">
					{error}
				</p>
			)}

			{store && (
				<section className="merchant-controls" aria-labelledby="operations-heading">
					<h2 id="operations-heading">營運控制</h2>

					<div className="store-control" data-testid="store-control">
						<div>
							<h3>接單狀態</h3>
							<strong className={store.is_accepting_orders ? "accepting" : "paused"}>
								{store.is_accepting_orders ? "接單中" : "暫停接單"}
							</strong>
						</div>
						<div className="store-actions">
							<button
								type="button"
								className="pause-store-button"
								disabled={storeMutationInFlight || !store.is_accepting_orders}
								onClick={() => void pauseStore()}
							>
								暫停接單
							</button>
							<button
								type="button"
								className="resume-store-button"
								disabled={
									storeMutationInFlight || store.is_accepting_orders || !merchantAccessHealthy
								}
								onClick={() => void resumeStore()}
							>
								恢復接單
							</button>
						</div>
					</div>
					<p className="store-sync-status">
						權威狀態版本：{store.stateVersion}；最後同步：
						{lastSyncAt ? formatDateTime(lastSyncAt.toISOString()) : "尚未同步"}
						{lastStoreOperation ? `；最近操作：${lastStoreOperation.outcome}` : ""}
					</p>

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

			<section className="merchant-notifications" aria-labelledby="notifications-heading">
				<h2 id="notifications-heading">通知狀態</h2>
				{notifications.length === 0 ? (
					<p>目前沒有通知紀錄。</p>
				) : (
					<ul>
						{notifications.map((delivery) => {
							const lastAttemptTime = delivery.lastAttemptAt
								? new Date(delivery.lastAttemptAt).getTime()
								: null;
							const isStalePending =
								delivery.status === "pending" &&
								lastAttemptTime !== null &&
								Date.now() - lastAttemptTime >= 60_000;
							const canRetry =
								delivery.status === "failed" ||
								(delivery.status === "pending" &&
									(delivery.attemptCount === 0 ||
										delivery.lastAttemptAt === null ||
										isStalePending));

							return (
								<li key={delivery.id}>
									<div>
										<strong>訂單 #{delivery.orderNumber}</strong>
										<span>
											{delivery.channel === "web_push" ? "Web Push" : "舊 LINE 紀錄"} ·{" "}
											{delivery.status === "sent" ? "已通知" : delivery.status === "failed" ? "傳送失敗" : "傳送中"}
										</span>
										<small>已嘗試 {delivery.attemptCount} 次</small>
									</div>
									{delivery.channel === "web_push" && canRetry && (
										<button
											type="button"
											disabled={processingControl !== null}
											onClick={() => retryNotification(delivery.id)}
										>
											重新傳送
										</button>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</section>

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
						<article
							className={`merchant-order ${order.specialOrder ? "special" : ""} ${newOrderIds.has(order.id) ? "new-order" : ""}`}
							key={order.id}
						>
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
