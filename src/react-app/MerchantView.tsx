import { useEffect, useRef, useState } from "react";
import {
	MerchantAvailabilityScreen,
	MerchantOrderCard,
	MerchantPrimaryNavigation,
} from "./MerchantComponents";
import {
	sortOrdersByReadyDeadline,
	type MerchantMenuCategory,
	type MerchantMenuItem,
	type MerchantOrder,
	type MerchantViewName,
} from "./merchant-operations";
import { findNewPendingOrderIds, selectNewestStoreSnapshot } from "./merchant-polling";
import {
	formatTaipeiDeadlineDateTime,
	formatTaipeiDeadlineTime,
} from "./taipei-time";

type MerchantOrdersResponse = {
	orders: MerchantOrder[];
	history?: MerchantOrder[];
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
	operation: {
		outcome: "APPLIED" | "ALREADY_IN_TARGET_STATE" | "STALE_STATE";
		store: { is_accepting_orders: boolean };
		stateVersion: number;
		createdAt: string;
	};
	store: { is_accepting_orders: boolean };
	stateVersion: number;
	createdAt: string;
};

type MenuResponse = {
	categories: MerchantMenuCategory[];
};

type MerchantAction = "accept" | "reject" | "complete";
type MerchantWorkflowView = "pending" | "accepted" | "history";
type MerchantActionFeedback = { tone: "success" | "warning"; message: string };

const MERCHANT_REFRESH_INTERVAL_MS = 5_000;
const MERCHANT_LARGE_TEXT_STORAGE_KEY = "merchant-large-text";
const SHOW_NOTIFICATION_CONTROLS = false;

class ConclusiveStoreOperationError extends Error {}
class StoreStillAcceptingAfterPauseError extends Error {}

type PushState = "checking" | "unsupported" | "default" | "denied" | "enabled" | "disabled";

function supportsWebPush() {
	return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function base64UrlToUint8Array(value: string) {
	const padding = "=".repeat((4 - (value.length % 4)) % 4);
	const decoded = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function formatDateTime(timestamp: string) {
	return formatTaipeiDeadlineDateTime(timestamp) ?? "時間未記錄";
}

function readLargeTextPreference() {
	try {
		return localStorage.getItem(MERCHANT_LARGE_TEXT_STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

async function readApiErrorCode(response: Response) {
	try {
		const body = await response.json() as { error?: { code?: unknown } };
		return typeof body.error?.code === "string" ? body.error.code : null;
	} catch {
		return null;
	}
}

export default function MerchantView() {
	const [orders, setOrders] = useState<MerchantOrder[]>([]);
	const [historyOrders, setHistoryOrders] = useState<MerchantOrder[]>([]);
	const [notifications, setNotifications] = useState<MerchantNotification[]>([]);
	const [store, setStore] = useState<StoreSettings | null>(null);
	const [menuCategories, setMenuCategories] = useState<MerchantMenuCategory[]>([]);
	const [activeView, setActiveView] = useState<MerchantViewName>("orders");
	const [workflowView, setWorkflowView] = useState<MerchantWorkflowView>("pending");
	const [pendingDisplay, setPendingDisplay] = useState<"focus" | "list">("focus");
	const [selectedPendingId, setSelectedPendingId] = useState<string | null>(null);
	const [selectedAcceptedId, setSelectedAcceptedId] = useState<string | null>(null);
	const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
	const [lastAcceptedOrderId, setLastAcceptedOrderId] = useState<string | null>(null);
	const [actionFeedback, setActionFeedback] = useState<MerchantActionFeedback | null>(null);
	const [processingAction, setProcessingAction] = useState<MerchantAction | null>(null);
	const [largeText, setLargeText] = useState(readLargeTextPreference);
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
	const orderActionInFlightRef = useRef(false);
	const shortageAttemptIdsRef = useRef(new Map<string, string>());
	const storeEpoch = useRef(0);
	const newestStoreVersion = useRef(-1);
	const ordersRef = useRef<MerchantOrder[]>([]);
	const historyOrdersRef = useRef<MerchantOrder[]>([]);
	const selectedPendingIdRef = useRef<string | null>(null);
	const selectedAcceptedIdRef = useRef<string | null>(null);
	ordersRef.current = orders;
	historyOrdersRef.current = historyOrders;
	selectedPendingIdRef.current = selectedPendingId;
	selectedAcceptedIdRef.current = selectedAcceptedId;

	useEffect(() => {
		try {
			localStorage.setItem(MERCHANT_LARGE_TEXT_STORAGE_KEY, String(largeText));
		} catch {
			// The preference remains available for this page when storage is unavailable.
		}
	}, [largeText]);

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
				}
				const previouslySelectedPending = ordersRef.current.find(
					(order) => order.id === selectedPendingIdRef.current && order.status === "pending",
				);
				const previouslySelectedAccepted = ordersRef.current.find(
					(order) => order.id === selectedAcceptedIdRef.current && order.status === "accepted",
				);
				const pendingStillCurrent = previouslySelectedPending
					? ordersResult.orders.some(
						(order) => order.id === previouslySelectedPending.id && order.status === "pending",
					)
					: true;
				const acceptedStillCurrent = previouslySelectedAccepted
					? ordersResult.orders.some(
						(order) => order.id === previouslySelectedAccepted.id && order.status === "accepted",
					)
					: true;
				if (!orderActionInFlightRef.current && (!pendingStillCurrent || !acceptedStillCurrent)) {
					const changedOrder = previouslySelectedPending ?? previouslySelectedAccepted;
					setActionFeedback({
						tone: "warning",
						message: `#${changedOrder?.orderNumber ?? "訂單"} 已由其他裝置更新，畫面已同步最新狀態。`,
					});
				}
				ordersRef.current = ordersResult.orders;
				historyOrdersRef.current = ordersResult.history ?? [];
				setOrders(ordersResult.orders);
				setHistoryOrders(ordersResult.history ?? []);
				setNotifications(notificationsResult.deliveries);
				const acceptedStoreSnapshot = applyStoreSnapshot(
					parseStoreSettings(storeResult),
					requestEpoch,
				);
				setMenuCategories(menuResult.categories);
				if (acceptedStoreSnapshot) {
					setLastSyncAt(new Date());
					setMerchantAccessHealthy(true);
					setError(null);
				}
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

	useEffect(() => {
		const pending = sortOrdersByReadyDeadline(orders.filter((order) => order.status === "pending"));
		setSelectedPendingId((current) =>
			current && pending.some((order) => order.id === current) ? current : pending[0]?.id ?? null,
		);
	}, [orders]);

	useEffect(() => {
		const accepted = sortOrdersByReadyDeadline(orders.filter((order) => order.status === "accepted"));
		setSelectedAcceptedId((current) =>
			current && accepted.some((order) => order.id === current) ? current : accepted[0]?.id ?? null,
		);
	}, [orders]);

	useEffect(() => {
		setSelectedHistoryId((current) =>
			current && historyOrders.some((order) => order.id === current)
				? current
				: historyOrders[0]?.id ?? null,
		);
	}, [historyOrders]);

	async function fetchOrderCollections() {
		const response = await fetch("/api/merchant/orders", { cache: "no-store" });
		if (!response.ok) throw new Error("Merchant Orders refresh failed");
		const result = await response.json() as MerchantOrdersResponse;
		return { orders: result.orders, history: result.history ?? [] };
	}

	function applyOrderCollections(collections: { orders: MerchantOrder[]; history: MerchantOrder[] }) {
		ordersRef.current = collections.orders;
		historyOrdersRef.current = collections.history;
		setOrders(collections.orders);
		setHistoryOrders(collections.history);
		setLastSyncAt(new Date());
		setMerchantAccessHealthy(true);
	}

	function applyConfirmedOrderAction(updatedOrder: MerchantOrder, action: MerchantAction) {
		const activeWithoutOrder = ordersRef.current.filter((order) => order.id !== updatedOrder.id);
		const nextActive = action === "accept"
			? sortOrdersByReadyDeadline([...activeWithoutOrder, updatedOrder])
			: sortOrdersByReadyDeadline(activeWithoutOrder);
		ordersRef.current = nextActive;
		setOrders(nextActive);
		setNewOrderIds((current) => {
			const next = new Set(current);
			next.delete(updatedOrder.id);
			return next;
		});

		if (action === "accept") {
			setLastAcceptedOrderId(updatedOrder.id);
			setSelectedAcceptedId(updatedOrder.id);
			setSelectedPendingId(
				nextActive.find((order) => order.status === "pending")?.id ?? null,
			);
			setPendingDisplay("focus");
			setActionFeedback({
				tone: "success",
				message: `已接單 #${updatedOrder.orderNumber}`,
			});
			return;
		}

		const nextHistory = [
			updatedOrder,
			...historyOrdersRef.current.filter((order) => order.id !== updatedOrder.id),
		];
		historyOrdersRef.current = nextHistory;
		setHistoryOrders(nextHistory);
		if (action === "reject") {
			setSelectedPendingId(
				nextActive.find((order) => order.status === "pending")?.id ?? null,
			);
			setActionFeedback({ tone: "success", message: `已拒單 #${updatedOrder.orderNumber}` });
		} else {
			setSelectedAcceptedId(
				nextActive.find((order) => order.status === "accepted")?.id ?? null,
			);
			setActionFeedback({ tone: "success", message: `已完成 #${updatedOrder.orderNumber}` });
		}
	}

	async function reconcileUnknownOrderAction(order: MerchantOrder, action: MerchantAction) {
		try {
			const collections = await fetchOrderCollections();
			applyOrderCollections(collections);
			const authoritative = [...collections.orders, ...collections.history]
				.find((candidate) => candidate.id === order.id);
			const expectedStatus = action === "accept"
				? "accepted"
				: action === "reject"
					? "rejected"
					: "completed";
			if (authoritative?.status === expectedStatus) {
				applyConfirmedOrderAction(authoritative, action);
				return;
			}
			setActionFeedback({
				tone: "warning",
				message: `#${order.orderNumber} 操作結果尚未確認，已保留目前權威狀態；請勿連續重送。`,
			});
		} catch {
			setMerchantAccessHealthy(false);
			setActionFeedback({
				tone: "warning",
				message: `#${order.orderNumber} 操作結果不明且暫時無法重新同步，請勿重複操作。`,
			});
		}
	}

	async function performAction(order: MerchantOrder, action: MerchantAction) {
		if (orderActionInFlightRef.current) return;
		if (action === "reject" && !window.confirm(`確定拒絕訂單 #${order.orderNumber}？`)) {
			return;
		}

		orderActionInFlightRef.current = true;
		const orderId = order.id;
		setProcessingControl(`order-${orderId}`);
		setProcessingAction(action);
		setError(null);
		setActionFeedback(null);
		const controller = new AbortController();
		const timeout = window.setTimeout(() => controller.abort(), 12_000);

		try {
			const response = await fetch(`/api/merchant/orders/${encodeURIComponent(orderId)}/${action}`, {
				method: "POST",
				signal: controller.signal,
			});

			if (!response.ok) {
				const code = await readApiErrorCode(response);
				if (response.status === 403) {
					setError(`商家身分或操作來源驗證失敗（${code ?? "AUTH_DENIED"}），訂單未變更。`);
					return;
				}
				if (response.status === 409) {
					try {
						applyOrderCollections(await fetchOrderCollections());
					} finally {
						setActionFeedback({
							tone: "warning",
							message: `#${order.orderNumber} 已被其他裝置更新，已重新同步最新狀態。`,
						});
					}
					return;
				}
				if (response.status >= 400 && response.status < 500) {
					setError(`訂單操作被拒絕（${code ?? response.status}），訂單未變更。`);
					return;
				}
				await reconcileUnknownOrderAction(order, action);
				return;
			}

			const result = await response.json() as { order: MerchantOrder };
			applyConfirmedOrderAction(result.order, action);
			setRefreshVersion((current) => current + 1);
		} catch {
			await reconcileUnknownOrderAction(order, action);
		} finally {
			window.clearTimeout(timeout);
			orderActionInFlightRef.current = false;
			setProcessingAction(null);
			setProcessingControl(null);
		}
	}

	async function performShortage(order: MerchantOrder, items: Array<{ orderItemId: string; quantity: number }>) {
		if (orderActionInFlightRef.current) return false;
		const attemptKey = `${order.id}:${JSON.stringify(items)}`;
		const requestId = shortageAttemptIdsRef.current.get(attemptKey) ?? crypto.randomUUID();
		shortageAttemptIdsRef.current.set(attemptKey, requestId);
		orderActionInFlightRef.current = true;
		setProcessingControl(`order-${order.id}`);
		setError(null);
		setActionFeedback(null);
		try {
			const response = await fetch(`/api/merchant/orders/${encodeURIComponent(order.id)}/shortages`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ requestId, items }),
			});
			if (!response.ok) {
				const code = await readApiErrorCode(response);
				if (response.status < 500) shortageAttemptIdsRef.current.delete(attemptKey);
				if (response.status === 409) applyOrderCollections(await fetchOrderCollections());
				setError(`品項不足處理未完成（${code ?? response.status}），請依最新訂單狀態確認。`);
				return false;
			}
			shortageAttemptIdsRef.current.delete(attemptKey);
			const result = await response.json() as { order: MerchantOrder };
			applyOrderCollections(await fetchOrderCollections());
			setActionFeedback({
				tone: "success",
				message: result.order.status === "cancelled"
					? `#${order.orderNumber} 已依顧客選擇取消`
					: `#${order.orderNumber} 已更新，應付 NT$ ${result.order.total}`,
			});
			return true;
		} catch {
			setActionFeedback({ tone: "warning", message: `#${order.orderNumber} 品項不足處理結果不明；再次確認會沿用同一操作識別。` });
			return false;
		} finally {
			orderActionInFlightRef.current = false;
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

	async function performAvailabilityAction(item: MerchantMenuItem) {
		const controlKey = `item-${item.id}`;
		const endpoint = `/api/merchant/menu-items/${item.id}/${item.isAvailable ? "sold-out" : "restore"}`;
		setProcessingControl(controlKey);
		setError(null);

		try {
			const response = await fetch(endpoint, { method: "POST" });

			if (!response.ok) {
				throw new Error("Availability action failed");
			}

			setRefreshVersion((current) => current + 1);
		} catch {
			setError("商品狀態更新失敗，畫面仍保留原狀。請確認連線後再試。");
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
			!("operation" in value) ||
			typeof value.operation !== "object" ||
			value.operation === null ||
			!("outcome" in value.operation) ||
			!["APPLIED", "ALREADY_IN_TARGET_STATE", "STALE_STATE"].includes(
				String(value.operation.outcome),
			) ||
			!("store" in value.operation) ||
			typeof value.operation.store !== "object" ||
			value.operation.store === null ||
			!("is_accepting_orders" in value.operation.store) ||
			typeof value.operation.store.is_accepting_orders !== "boolean" ||
			!("stateVersion" in value.operation) ||
			typeof value.operation.stateVersion !== "number" ||
			!Number.isSafeInteger(value.operation.stateVersion) ||
			value.operation.stateVersion < 0 ||
			!("createdAt" in value.operation) ||
			typeof value.operation.createdAt !== "string" ||
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
			const authoritative = await refreshStoreAfterOperation();
			if (authoritative.is_accepting_orders) {
				throw new StoreStillAcceptingAfterPauseError();
			}
			return;
		}

		const authoritative = await refreshStoreAfterOperation();
		if (!authoritative.is_accepting_orders) return;
		const replay = await postStoreOperation("pause", operationId, expected);
		applyOperationResult(replay);
		const afterReplay = await refreshStoreAfterOperation();
		if (afterReplay.is_accepting_orders) {
			throw new StoreStillAcceptingAfterPauseError();
		}
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
				const authoritative = await refreshStoreAfterOperation();
				if (authoritative.is_accepting_orders) {
					throw new StoreStillAcceptingAfterPauseError();
				}
			} catch (operationError) {
				if (operationError instanceof ConclusiveStoreOperationError) throw operationError;
				await recoverAmbiguousPause(operationId, expected);
			}
		} catch (operationError) {
			setError(
				operationError instanceof StoreStillAcceptingAfterPauseError
					? "緊急：暫停接單尚未生效，店家目前仍在接單。請立即再次確認並手動暫停。"
					: "暫停接單結果不明，請查看最新店家狀態；系統不會建立新的操作編號。",
			);
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

	const connectionState =
		!isOnline || (!isLoading && !merchantAccessHealthy)
			? "disconnected"
			: merchantAccessHealthy
				? "connected"
				: "connecting";
	const pendingOrders = sortOrdersByReadyDeadline(
		orders.filter((order) => order.status === "pending"),
	);
	const acceptedOrders = sortOrdersByReadyDeadline(
		orders.filter((order) => order.status === "accepted"),
	);
	const selectedPendingOrder =
		pendingOrders.find((order) => order.id === selectedPendingId) ?? pendingOrders[0] ?? null;
	const selectedPendingIndex = selectedPendingOrder
		? pendingOrders.findIndex((order) => order.id === selectedPendingOrder.id)
		: -1;
	const selectedAcceptedOrder =
		acceptedOrders.find((order) => order.id === selectedAcceptedId) ?? acceptedOrders[0] ?? null;
	const selectedHistoryOrder =
		historyOrders.find((order) => order.id === selectedHistoryId) ?? historyOrders[0] ?? null;
	return (
		<main className={`merchant-page${largeText ? " large-text" : ""}`}>
			<header className="merchant-header">
				<div>
					<p className="eyebrow">吃炸的</p>
					<h1>店家工作台</h1>
					<p>待接單 {pendingOrders.length} 筆 · 製作中 {acceptedOrders.length} 筆</p>
				</div>
				<div className="merchant-header-actions">
					<div className={`merchant-compact-connection ${connectionState}`} aria-label="連線狀態" aria-live="polite">
						<span className={`status-dot ${connectionState === "connected" ? "online" : "offline"}`} />
						<strong>{connectionState === "connected" ? "連線正常" : connectionState === "connecting" ? "連線中" : "連線中斷"}</strong>
					</div>
					<button type="button" className="merchant-history-link" onClick={() => { setActiveView("orders"); setWorkflowView("history"); }}>歷史訂單</button>
					<button
						type="button"
						className="merchant-large-text-toggle"
						aria-pressed={largeText}
						onClick={() => setLargeText((current) => !current)}
					>
						大字模式
					</button>
				</div>
			</header>

			<MerchantPrimaryNavigation
				activeView={activeView}
				workflowView={workflowView}
				pendingCount={pendingOrders.length}
				acceptedCount={acceptedOrders.length}
				onChange={(next) => {
					if (next === "availability") setActiveView("availability");
					else { setActiveView("orders"); setWorkflowView(next); }
				}}
			/>

			{SHOW_NOTIFICATION_CONTROLS && <section
				className={`merchant-connection-status ${connectionState}`}
				aria-label="連線狀態"
				aria-live="polite"
			>
				<div>
					<span className={`status-dot ${connectionState === "connected" ? "online" : "offline"}`} />
					<strong>
						{connectionState === "connected"
							? "連線正常"
							: connectionState === "connecting"
								? "連線中"
								: "連線中斷"}
					</strong>
					<small>
						最後同步 {lastSyncAt ? formatDateTime(lastSyncAt.toISOString()) : "尚未同步"}
					</small>
				</div>
				<div className="merchant-push-control">
					<span>
						通知{pushState === "enabled" ? "已開啟" : pushState === "checking" ? "確認中" : "未開啟"}
					</span>
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
				{pushState === "unsupported" && <p>請將店家頁加入主畫面後再開啟通知。</p>}
				{pushState === "denied" && <p>通知已被瀏覽器拒絕，請從系統設定重新允許。</p>}
			</section>}

			{error && <p className="merchant-message merchant-error" role="alert">{error}</p>}
			{actionFeedback && (
				<p
					className={`merchant-message merchant-action-feedback ${actionFeedback.tone}`}
					role="status"
				>
					{actionFeedback.message}
				</p>
			)}

			{activeView === "availability" ? (
				<MerchantAvailabilityScreen
					categories={menuCategories}
					processingControl={processingControl}
					onToggle={(item) => void performAvailabilityAction(item)}
				/>
			) : (
				<>
					{isLoading && <p className="merchant-message" role="status">訂單載入中…</p>}
					<section className="merchant-workbench" aria-label="接單工作區">
						<div className="merchant-workbench-tools">
							{lastAcceptedOrderId && acceptedOrders.some((order) => order.id === lastAcceptedOrderId) && (
								<button
									type="button"
									className="recent-order-link"
									onClick={() => {
										setWorkflowView("accepted");
										setSelectedAcceptedId(lastAcceptedOrderId);
									}}
								>
									查看剛接的訂單
								</button>
							)}
						</div>

						{workflowView === "pending" && (
							<section className="merchant-workflow-panel" aria-labelledby="pending-orders-heading">
								<header className="merchant-workflow-heading">
									<div>
										<h2 id="pending-orders-heading">待接單</h2>
										{selectedPendingIndex >= 0 && pendingDisplay === "focus" && (
											<p>待接單 {selectedPendingIndex + 1}／{pendingOrders.length}</p>
										)}
									</div>
									{pendingOrders.length > 0 && (
										<button type="button" onClick={() => setPendingDisplay((current) => current === "focus" ? "list" : "focus")}>
											{pendingDisplay === "focus" ? "返回待接單清單" : "查看目前訂單"}
										</button>
									)}
								</header>

								{!isLoading && pendingOrders.length === 0 && (
									<div className="merchant-empty-workflow">
										<strong>目前沒有待接單</strong>
										<p>已接下的訂單仍可在製作中查看完整內容。</p>
										<button type="button" onClick={() => setWorkflowView("accepted")}>查看製作中訂單</button>
									</div>
								)}

								{pendingDisplay === "list" && pendingOrders.length > 0 && (
									<ul className="merchant-order-picker" aria-label="待接單清單">
										{pendingOrders.map((order) => (
											<li key={order.id}>
												<button type="button" onClick={() => {
													setSelectedPendingId(order.id);
													setPendingDisplay("focus");
												}}>
													<strong>{formatTaipeiDeadlineTime(order.estimatedReadyAt) ?? "截止時間未記錄"}</strong>
											<span>{order.items.reduce((total, item) => total + item.quantity, 0)} 份</span>
												</button>
											</li>
										))}
									</ul>
								)}

								{pendingDisplay === "focus" && selectedPendingOrder && (
									<>
										<div className="merchant-order-pager" aria-label="切換待接單">
											<button type="button" disabled={selectedPendingIndex <= 0} onClick={() => setSelectedPendingId(pendingOrders[selectedPendingIndex - 1]?.id ?? null)}>上一筆</button>
											<button type="button" disabled={selectedPendingIndex >= pendingOrders.length - 1} onClick={() => setSelectedPendingId(pendingOrders[selectedPendingIndex + 1]?.id ?? null)}>下一筆</button>
										</div>
										<MerchantOrderCard
											order={selectedPendingOrder}
											isNew={newOrderIds.has(selectedPendingOrder.id)}
											isProcessing={processingControl === `order-${selectedPendingOrder.id}`}
											processingAction={processingControl === `order-${selectedPendingOrder.id}` ? processingAction : null}
											onAction={(action) => void performAction(selectedPendingOrder, action)}
											onShortage={(items) => performShortage(selectedPendingOrder, items)}
										/>
									</>
								)}
							</section>
						)}

						{workflowView === "accepted" && (
							<section className="merchant-workflow-panel" aria-labelledby="accepted-orders-heading">
								<header className="merchant-workflow-heading">
									<div><h2 id="accepted-orders-heading">製作中</h2><p>依預計完成時間排序</p></div>
								</header>
								{acceptedOrders.length === 0 ? (
									<div className="merchant-empty-workflow"><strong>目前沒有製作中訂單</strong></div>
								) : (
									<>
										<ul className="merchant-order-picker" aria-label="製作中訂單清單">
											{acceptedOrders.map((order) => (
												<li key={order.id}>
													<button type="button" aria-current={selectedAcceptedOrder?.id === order.id ? "true" : undefined} onClick={() => setSelectedAcceptedId(order.id)}>
														<strong>{formatTaipeiDeadlineTime(order.estimatedReadyAt) ?? "截止時間未記錄"}{lastAcceptedOrderId === order.id ? " · 剛接" : ""}</strong>
												<span>{order.items.reduce((total, item) => total + item.quantity, 0)} 份</span>
													</button>
												</li>
											))}
										</ul>
										{selectedAcceptedOrder && (
											<MerchantOrderCard
												order={selectedAcceptedOrder}
												isNew={false}
												isProcessing={processingControl === `order-${selectedAcceptedOrder.id}`}
												processingAction={processingControl === `order-${selectedAcceptedOrder.id}` ? processingAction : null}
												onAction={(action) => void performAction(selectedAcceptedOrder, action)}
												onShortage={(items) => performShortage(selectedAcceptedOrder, items)}
											/>
										)}
									</>
								)}
							</section>
						)}

						{workflowView === "history" && (
							<section className="merchant-workflow-panel" aria-labelledby="history-orders-heading">
								<header className="merchant-workflow-heading"><div><h2 id="history-orders-heading">歷史訂單</h2><p>最近完成與拒絕的訂單</p></div></header>
								{historyOrders.length === 0 ? (
									<div className="merchant-empty-workflow"><strong>目前沒有歷史訂單</strong></div>
								) : (
									<>
										<ul className="merchant-order-picker" aria-label="歷史訂單清單">
											{historyOrders.map((order) => (
											<li key={order.id}><button type="button" aria-current={selectedHistoryOrder?.id === order.id ? "true" : undefined} onClick={() => setSelectedHistoryId(order.id)}><strong>{formatTaipeiDeadlineDateTime(order.estimatedReadyAt) ?? "截止時間未記錄"}</strong><span>{order.status === "completed" ? "已完成" : order.status === "cancelled" ? "已取消" : "已拒單"} · NT$ {order.total}</span><small>訂單 #{order.orderNumber}</small></button></li>
											))}
										</ul>
										{selectedHistoryOrder && <MerchantOrderCard order={selectedHistoryOrder} isNew={false} isProcessing={false} processingAction={null} onAction={() => undefined} />}
									</>
								)}
							</section>
						)}
					</section>

					{store && (
						<section className="merchant-controls merchant-secondary-controls" aria-labelledby="operations-heading">
							<h2 id="operations-heading">接單安全控制</h2>
							<div className="store-control" data-testid="store-control">
								<div>
									<h3>全店接單狀態</h3>
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
										disabled={storeMutationInFlight || store.is_accepting_orders || !merchantAccessHealthy}
										onClick={() => void resumeStore()}
									>
										營業中
									</button>
								</div>
							</div>
							<p className="store-sync-status">
								權威狀態版本：{store.stateVersion}；最後同步：
								{lastSyncAt ? formatDateTime(lastSyncAt.toISOString()) : "尚未同步"}
								{lastStoreOperation ? `；最近操作：${lastStoreOperation.outcome}` : ""}
							</p>
						</section>
					)}

					{SHOW_NOTIFICATION_CONTROLS && <section className="merchant-notifications" aria-labelledby="notifications-heading">
						<h2 id="notifications-heading">通知狀態</h2>
						{notifications.length === 0 ? <p>目前沒有通知紀錄。</p> : (
							<ul>
								{notifications.map((delivery) => {
									const lastAttemptTime = delivery.lastAttemptAt ? new Date(delivery.lastAttemptAt).getTime() : null;
									const isStalePending = delivery.status === "pending" && lastAttemptTime !== null && Date.now() - lastAttemptTime >= 60_000;
									const canRetry = delivery.status === "failed" || (delivery.status === "pending" && (delivery.attemptCount === 0 || delivery.lastAttemptAt === null || isStalePending));
									return (
										<li key={delivery.id}>
											<div>
												<strong>訂單 #{delivery.orderNumber}</strong>
												<span>{delivery.channel === "web_push" ? "Web Push" : "舊 LINE 紀錄"} · {delivery.status === "sent" ? "已通知" : delivery.status === "failed" ? "傳送失敗" : "傳送中"}</span>
												<small>已嘗試 {delivery.attemptCount} 次</small>
											</div>
											{delivery.channel === "web_push" && canRetry && (
												<button type="button" disabled={processingControl !== null} onClick={() => retryNotification(delivery.id)}>重新傳送</button>
											)}
										</li>
									);
								})}
							</ul>
						)}
					</section>}
				</>
			)}

			<p className="merchant-security-note">店家頁已啟用身分驗證。</p>
		</main>
	);
}
