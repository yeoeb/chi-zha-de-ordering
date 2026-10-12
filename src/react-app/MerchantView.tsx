import { uiCopy } from "./ui-copy";
import { useCallback, useEffect, useRef, useState } from "react";
import { getNavigationSurface, useReturnNavigation } from "./return-navigation";
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
import { MerchantDeadlineEvents, selectMerchantFocus, type MerchantFocus } from "./merchant-focus";
import { maintainMerchantWakeLock } from "./merchant-wake-lock";
import {
	formatBusinessDateLabel,
	formatBusinessDateFull,
	formatTaipeiDeadlineDateTime,
	formatTaipeiDeadlineTime,
	getStoreBusinessDate,
	listStoreBusinessDates,
} from "./taipei-time";
import { DestructiveConfirmationDialog } from "./DestructiveConfirmationDialog";
import { MerchantForegroundAudioController } from "./merchant-audio";

type MerchantOrdersResponse = {
	orders: MerchantOrder[];
};
type MerchantHistoryResponse = { history: MerchantOrder[] };
type MerchantRevenueSummary = {
	businessDate: string;
	revenue: number;
	effectiveOrderCount: number;
	averageOrderValue: number;
	itemQuantity: number;
	topItems: Array<{ name: string; quantity: number }>;
	busiestHour: string | null;
	cancelledCount: number;
	rejectedCount: number;
	soldOutItems: Array<{ id: number; name: string }>;
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
	busyMode: boolean;
	missedOrderCount: number;
	autoPauseReason: "missed_orders" | null;
	newOrderSoundEnabled: boolean;
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
type MerchantWorkflowView = "pending" | "accepted";
type MerchantActionFeedback = { tone: "success" | "warning"; message: string };

const MERCHANT_REFRESH_INTERVAL_MS = 5_000;
const MERCHANT_LARGE_TEXT_STORAGE_KEY = "merchant-large-text";
const SHOW_NOTIFICATION_DELIVERY_HISTORY = false;
class ConclusiveStoreOperationError extends Error {}
class StoreStillAcceptingAfterPauseError extends Error {}

type PushState = "checking" | "unsupported" | "default" | "denied" | "enabled" | "disabled";

function supportsWebPush() {
	if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
		return false;
	}
	const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
	const standalone = (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) ||
		Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
	if (ios && !standalone) return false;
	const loopback = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
	return !loopback || navigator.serviceWorker.controller !== null;
}

function base64UrlToUint8Array(value: string) {
	const padding = "=".repeat((4 - (value.length % 4)) % 4);
	const decoded = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function formatDateTime(timestamp: string) {
	return formatTaipeiDeadlineDateTime(timestamp) ?? uiCopy.common.timeMissing;
}

function pickupReference(order: Pick<MerchantOrder, "estimatedReadyAt">) {
	return `${uiCopy.merchant.readyTimePrefix}${formatTaipeiDeadlineTime(order.estimatedReadyAt) ?? uiCopy.common.timeMissing}`;
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
	const [initialSurface] = useState(() => window.location.pathname === "/merchant/history" ? "history" : window.location.pathname === "/merchant/revenue" ? "revenue" : getNavigationSurface("merchant") ?? "root");
	const [orders, setOrders] = useState<MerchantOrder[]>([]);
	const [historyOrders, setHistoryOrders] = useState<MerchantOrder[]>([]);
	const [notifications, setNotifications] = useState<MerchantNotification[]>([]);
	const [store, setStore] = useState<StoreSettings | null>(null);
	const [menuCategories, setMenuCategories] = useState<MerchantMenuCategory[]>([]);
	const [activeView, setActiveView] = useState<MerchantViewName>(initialSurface === "availability" ? "availability" : "orders");
	const [workflowView, setWorkflowView] = useState<MerchantWorkflowView>(initialSurface === "accepted" ? "accepted" : "pending");
	const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
	const [selectedHistoryDate, setSelectedHistoryDate] = useState(() => getStoreBusinessDate());
	const [historyPanelOpen, setHistoryPanelOpen] = useState(() => window.location.pathname === "/merchant/history");
	const [historyDatePickerOpen, setHistoryDatePickerOpen] = useState(false);
	const [historyLoading, setHistoryLoading] = useState(false);
	const [revenuePanelOpen, setRevenuePanelOpen] = useState(() => window.location.pathname === "/merchant/revenue");
	const [revenueLoading, setRevenueLoading] = useState(false);
	const [revenueSummary, setRevenueSummary] = useState<MerchantRevenueSummary | null>(null);
	const [returnRevision, setReturnRevision] = useState(0);
	const navigation = useReturnNavigation("merchant", "/merchant", initialSurface, (surface) => {
		setHistoryPanelOpen(surface === "history");
		setRevenuePanelOpen(surface === "revenue");
		setHistoryDatePickerOpen(false);
		setSelectedHistoryId(null);
		if (surface === "root") {
			setRejectCandidate(null);
			setReturnRevision((current) => current + 1);
			setActiveView("orders");
			setWorkflowView("pending");
		} else if (surface === "availability") setActiveView("availability");
		else if (surface === "accepted" || surface === "pending") {
			setRejectCandidate(null);
			setActiveView("orders"); setWorkflowView(surface);
		}
	});
	const [lastAcceptedOrderId, setLastAcceptedOrderId] = useState<string | null>(null);
	const [rejectCandidate, setRejectCandidate] = useState<MerchantOrder | null>(null);
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
	const [isRinging, setIsRinging] = useState(false);
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
	const historyListRef = useRef<HTMLElement | null>(null);
	const selectedHistoryDateRef = useRef<HTMLButtonElement | null>(null);
	const audioControllerRef = useRef<MerchantForegroundAudioController | null>(null);
	const audioGestureAttempted = useRef(false);
	const deadlineEvents = useRef(new MerchantDeadlineEvents());
	const ordersEpoch = useRef(0);
	const ordersRequestSequence = useRef(0);
	const focusStateRef = useRef({ activeView, workflowView, historyPanelOpen, revenuePanelOpen, rejectCandidate });
	focusStateRef.current = { activeView, workflowView, historyPanelOpen, revenuePanelOpen, rejectCandidate };
	ordersRef.current = orders;
	historyOrdersRef.current = historyOrders;

	const focusWorkflow = useCallback((next: MerchantFocus) => {
		const current = focusStateRef.current;
		if (current.activeView === "orders" && current.workflowView === next && !current.historyPanelOpen && !current.revenuePanelOpen && !current.rejectCandidate) return;
		navigation.open(next, "/merchant");
	}, [navigation]);

	const evaluateOrderFocus = useCallback((current: MerchantOrder[], discovered: string[]) => {
		const deadlines = deadlineEvents.current.observe(current, Date.now());
		const focus = focusStateRef.current;
		const next = selectMerchantFocus({
			newPending: discovered, deadlines,
			pending: current.filter((order) => order.status === "pending").length,
			accepted: current.filter((order) => order.status === "accepted").length,
			allowFallback: focus.activeView === "orders" && !focus.historyPanelOpen && !focus.revenuePanelOpen && !focus.rejectCandidate,
		});
		if (next) focusWorkflow(next);
	}, [focusWorkflow]);

	useEffect(() => maintainMerchantWakeLock(document, navigator), []);
	useEffect(() => {
		const sync = () => { if (document.visibilityState !== "hidden") setRefreshVersion((value) => value + 1); };
		document.addEventListener("visibilitychange", sync);
		window.addEventListener("pageshow", sync);
		const notification = (event: MessageEvent) => {
			if (event.data?.type === "MERCHANT_NOTIFICATION_OPEN") {
				focusWorkflow("pending");
				sync();
			}
		};
		navigator.serviceWorker?.addEventListener?.("message", notification);
		return () => {
			document.removeEventListener("visibilitychange", sync);
			window.removeEventListener("pageshow", sync);
			navigator.serviceWorker?.removeEventListener?.("message", notification);
		};
		// Stable navigation controller and current refs, not captured tabs.
	}, [focusWorkflow]);

	useEffect(() => {
		try {
			localStorage.setItem(MERCHANT_LARGE_TEXT_STORAGE_KEY, String(largeText));
		} catch {
			// The preference remains available for this page when storage is unavailable.
		}
	}, [largeText]);

	useEffect(() => {
		if (!historyDatePickerOpen) return;
		selectedHistoryDateRef.current?.scrollIntoView?.({ block: "center" });
	}, [historyDatePickerOpen, selectedHistoryDate]);

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
		return {
			...(value as Omit<StoreSettings, "busyMode" | "missedOrderCount" | "autoPauseReason">),
			busyMode: "busyMode" in value && typeof value.busyMode === "boolean" ? value.busyMode : false,
			missedOrderCount: "missedOrderCount" in value && typeof value.missedOrderCount === "number" ? value.missedOrderCount : 0,
			autoPauseReason: "autoPauseReason" in value && value.autoPauseReason === "missed_orders" ? "missed_orders" : null,
			newOrderSoundEnabled: "newOrderSoundEnabled" in value && typeof value.newOrderSoundEnabled === "boolean"
				? value.newOrderSoundEnabled
				: true,
		};
	}

	function closeOrderNotification(orderId: string) {
		if (!("serviceWorker" in navigator)) return;
		void navigator.serviceWorker.ready.then((registration) => {
			registration.active?.postMessage({ type: "CLOSE_ORDER_NOTIFICATION", orderId });
		}).catch(() => undefined);
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
		const controller = new MerchantForegroundAudioController(() => undefined, setIsRinging);
		audioControllerRef.current = controller;
		audioGestureAttempted.current = false;
		const recoverAudio = () => {
			if (document.visibilityState === "visible") void controller.recover();
			else controller.stopRing(); // Background delivery belongs to Web Push / OS.
		};
		document.addEventListener("visibilitychange", recoverAudio);
		return () => {
			document.removeEventListener("visibilitychange", recoverAudio);
			if (audioControllerRef.current === controller) audioControllerRef.current = null;
			controller.dispose();
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
			if (controller.signal.aborted) return;
			if (orderActionInFlightRef.current) {
				pollTimeout = window.setTimeout(loadMerchantData, MERCHANT_REFRESH_INTERVAL_MS);
				return;
			}
			const requestEpoch = storeEpoch.current;
			const orderEpoch = ordersEpoch.current;
			const sequence = ++ordersRequestSequence.current;
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

				const parsedStore = parseStoreSettings(storeResult);
				if (controller.signal.aborted || sequence !== ordersRequestSequence.current || orderEpoch !== ordersEpoch.current || orderActionInFlightRef.current) return;
				const discovered = findNewPendingOrderIds(
					seenOrderIds.current,
					ordersResult.orders,
					hasCompletedInitialLoad.current,
				);
				for (const order of ordersResult.orders) if (order.status === "pending") seenOrderIds.current.add(order.id);
				// Bound session memory while retaining all currently pending identities.
				if (seenOrderIds.current.size > 1000) {
					const pendingIds = new Set(ordersResult.orders.filter((order) => order.status === "pending").map((order) => order.id));
					for (const id of seenOrderIds.current) {
						if (!pendingIds.has(id)) seenOrderIds.current.delete(id);
						if (seenOrderIds.current.size <= 1000) break;
					}
				}
				hasCompletedInitialLoad.current = true;
				evaluateOrderFocus(ordersResult.orders, discovered);
				const pendingIds = new Set(ordersResult.orders.filter((order) => order.status === "pending").map((order) => order.id));
				setNewOrderIds((current) => new Set([...current, ...discovered].filter((id) => pendingIds.has(id))));
				audioControllerRef.current?.retainPendingOrders(ordersResult.orders.filter((order) => order.status === "pending").map((order) => order.id));
				if (!parsedStore.newOrderSoundEnabled) audioControllerRef.current?.stopRing();
				if (discovered.length > 0) {
					if (parsedStore.newOrderSoundEnabled && document.visibilityState !== "hidden" && audioControllerRef.current?.getState() === "ready") {
						void audioControllerRef.current.startRing(discovered);
					}
				}
				const changedOrder = ordersRef.current.find((previous) =>
					(previous.status === "pending" || previous.status === "accepted") &&
					!ordersResult.orders.some((current) => current.id === previous.id && current.status === previous.status),
				);
				if (!orderActionInFlightRef.current && changedOrder) {
					closeOrderNotification(changedOrder.id);
					const deadlineElapsed =
						changedOrder.status === "accepted" &&
						Number.isFinite(Date.parse(changedOrder.estimatedReadyAt)) &&
						Date.parse(changedOrder.estimatedReadyAt) <= Date.now();
					setActionFeedback({
						tone: "warning",
						message: deadlineElapsed
							? `${pickupReference(changedOrder)}${uiCopy.merchant.deadlineReachedSuffix}`
							: `${pickupReference(changedOrder)}${uiCopy.merchant.otherDeviceUpdatedSuffix}`,
					});
				}
				ordersRef.current = ordersResult.orders;
				setOrders(ordersResult.orders);
				setNotifications(notificationsResult.deliveries);
				const acceptedStoreSnapshot = applyStoreSnapshot(
					parsedStore,
					requestEpoch,
				);
				setMenuCategories(menuResult.categories);
				if (acceptedStoreSnapshot) {
					setLastSyncAt(new Date());
					setMerchantAccessHealthy(true);
					setError(null);
				}
			} catch (requestError) {
				if (!controller.signal.aborted && sequence === ordersRequestSequence.current && orderEpoch === ordersEpoch.current && !(requestError instanceof Error && requestError.name === "AbortError")) {
					setMerchantAccessHealthy(false);
					setError(uiCopy.merchant.ordersLoadFailed);
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
	}, [refreshVersion, evaluateOrderFocus]);

	async function fetchOrderCollections(includeHistory = false) {
		const epoch = ordersEpoch.current;
		const sequence = ++ordersRequestSequence.current;
		const response = await fetch("/api/merchant/orders", { cache: "no-store" });
		if (!response.ok) throw new Error("Merchant Orders refresh failed");
		const result = await response.json() as MerchantOrdersResponse;
		if (!includeHistory) {
			if (epoch !== ordersEpoch.current || sequence !== ordersRequestSequence.current) throw new Error("Order refresh superseded");
			return { orders: result.orders, history: historyOrdersRef.current };
		}
		const historyResponse = await fetch(`/api/merchant/orders/history?date=${encodeURIComponent(selectedHistoryDate)}`, { cache: "no-store" });
		if (!historyResponse.ok) throw new Error("Merchant history refresh failed");
		const history = await historyResponse.json() as MerchantHistoryResponse;
		if (epoch !== ordersEpoch.current || sequence !== ordersRequestSequence.current) throw new Error("Order refresh superseded");
		return { orders: result.orders, history: history.history };
	}

	async function openHistoryPanel() {
		const today = getStoreBusinessDate();
		setActiveView("orders");
		setRevenuePanelOpen(false);
		setHistoryPanelOpen(true);
		navigation.open("history", "/merchant/history");
		setSelectedHistoryDate(today);
		setSelectedHistoryId(null);
		await loadHistoryDate(today, false);
	}

	async function openRevenuePanel() {
		setHistoryPanelOpen(false);
		setHistoryDatePickerOpen(false);
		setRevenuePanelOpen(true);
		setRevenueLoading(true);
		setError(null);
		navigation.open("revenue", "/merchant/revenue");
		try {
			const response = await fetch("/api/merchant/revenue", { cache: "no-store" });
			if (!response.ok) throw new Error("Merchant revenue request failed");
			setRevenueSummary(await response.json() as MerchantRevenueSummary);
		} catch {
			setError(uiCopy.merchant.revenueLoadFailed);
		} finally {
			setRevenueLoading(false);
		}
	}

	function returnToWorkbench() {
		navigation.returnToRoot();
	}

	async function loadHistoryDate(businessDate: string, scrollToTop = true) {
		setHistoryLoading(true);
		setError(null);
		setSelectedHistoryId(null);
		try {
			const response = await fetch(`/api/merchant/orders/history?date=${encodeURIComponent(businessDate)}`, { cache: "no-store" });
			if (!response.ok) throw new Error("Merchant history request failed");
			const result = await response.json() as MerchantHistoryResponse;
			setSelectedHistoryDate(businessDate);
			historyOrdersRef.current = result.history;
			setHistoryOrders(result.history);
			if (scrollToTop) window.setTimeout(() => historyListRef.current?.scrollIntoView?.({ block: "start" }), 0);
		} catch {
			setError(uiCopy.merchant.historyLoadFailed);
		} finally {
			setHistoryLoading(false);
		}
	}

	function applyOrderCollections(collections: { orders: MerchantOrder[]; history: MerchantOrder[] }) {
		audioControllerRef.current?.retainPendingOrders(collections.orders.filter((order) => order.status === "pending").map((order) => order.id));
		ordersRef.current = collections.orders;
		historyOrdersRef.current = collections.history;
		setOrders(collections.orders);
		setHistoryOrders(collections.history);
		setLastSyncAt(new Date());
		setMerchantAccessHealthy(true);
	}

	function applyConfirmedOrderAction(updatedOrder: MerchantOrder, action: MerchantAction) {
		++ordersEpoch.current;
		const activeWithoutOrder = ordersRef.current.filter((order) => order.id !== updatedOrder.id);
		const nextActive = action === "accept"
			? sortOrdersByReadyDeadline([...activeWithoutOrder, updatedOrder])
			: sortOrdersByReadyDeadline(activeWithoutOrder);
		ordersRef.current = nextActive;
		audioControllerRef.current?.retainPendingOrders(nextActive.filter((order) => order.status === "pending").map((order) => order.id));
		setOrders(nextActive);
		setNewOrderIds((current) => {
			const next = new Set(current);
			next.delete(updatedOrder.id);
			return next;
		});

		if (action === "accept") {
			audioControllerRef.current?.stopRing();
			focusWorkflow("accepted");
			closeOrderNotification(updatedOrder.id);
			setLastAcceptedOrderId(updatedOrder.id);
			setActionFeedback({
				tone: "success",
				message: `${uiCopy.merchant.acceptedFeedbackPrefix}${pickupReference(updatedOrder)}`,
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
			closeOrderNotification(updatedOrder.id);
			setActionFeedback({ tone: "success", message: `${uiCopy.merchant.rejectedFeedbackPrefix}${pickupReference(updatedOrder)}` });
		} else {
			setActionFeedback({ tone: "success", message: `${uiCopy.merchant.completedFeedbackPrefix}${pickupReference(updatedOrder)}` });
		}
	}

	async function reconcileUnknownOrderAction(order: MerchantOrder, action: MerchantAction) {
		try {
			const collections = await fetchOrderCollections(true);
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
				message: `${pickupReference(order)}${uiCopy.merchant.unknownActionSyncedSuffix}`,
			});
		} catch {
			setMerchantAccessHealthy(false);
			setActionFeedback({
				tone: "warning",
				message: `${pickupReference(order)}${uiCopy.merchant.unknownActionOfflineSuffix}`,
			});
		}
	}

	async function executeOrderAction(order: MerchantOrder, action: MerchantAction) {
		if (orderActionInFlightRef.current) return;

		orderActionInFlightRef.current = true;
		++ordersEpoch.current;
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
					setError(`${uiCopy.merchant.authDeniedPrefix}${code ?? "AUTH_DENIED"}${uiCopy.merchant.actionDeniedSuffix}`);
					return;
				}
				if (response.status === 409) {
					try {
						applyOrderCollections(await fetchOrderCollections(true));
					} finally {
						setActionFeedback({
							tone: "warning",
							message: `${pickupReference(order)}${uiCopy.merchant.conflictSyncedSuffix}`,
						});
					}
					return;
				}
				if (response.status >= 400 && response.status < 500) {
					setError(`${uiCopy.merchant.actionDeniedPrefix}${code ?? response.status}${uiCopy.merchant.actionDeniedSuffix}`);
					return;
				}
				await reconcileUnknownOrderAction(order, action);
				return;
			}

			const result = await response.json() as { order: MerchantOrder };
			const expected = action === "accept" ? "accepted" : action === "reject" ? "rejected" : "completed";
			if (result.order?.id !== orderId || result.order.status !== expected) throw new Error("Order action response is invalid");
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

	function requestOrderAction(order: MerchantOrder, action: MerchantAction) {
		if (action === "reject") {
			navigation.open("confirmation", "/merchant");
			setRejectCandidate(order);
			return;
		}
		void executeOrderAction(order, action);
	}

	async function performShortage(order: MerchantOrder, items: Array<{ orderItemId: string; quantity: number }>) {
		if (orderActionInFlightRef.current) return false;
		const attemptKey = `${order.id}:${JSON.stringify(items)}`;
		const requestId = shortageAttemptIdsRef.current.get(attemptKey) ?? crypto.randomUUID();
		shortageAttemptIdsRef.current.set(attemptKey, requestId);
		orderActionInFlightRef.current = true;
		++ordersEpoch.current;
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
				setError(`${uiCopy.merchant.shortageFailedPrefix}${code ?? response.status}${uiCopy.merchant.shortageFailedSuffix}`);
				return false;
			}
			shortageAttemptIdsRef.current.delete(attemptKey);
			const result = await response.json() as { order: MerchantOrder };
			applyOrderCollections(await fetchOrderCollections());
			setRefreshVersion((current) => current + 1);
			const shortageNames = items.map((item) =>
				order.items.find((candidate) => candidate.id === item.orderItemId)?.name,
			).filter((name): name is string => Boolean(name));
			setActionFeedback({
				tone: "success",
				message: result.order.status === "cancelled"
					? `${pickupReference(order)}${uiCopy.merchant.shortageCancelledSuffix}${shortageNames.join("、")}${uiCopy.merchant.unavailableFeedback}`
					: `${pickupReference(order)}${uiCopy.merchant.shortageUpdatedSuffix}${shortageNames.join("、")}${uiCopy.merchant.shortageAmountPrefix}${result.order.total}`,
			});
			return true;
		} catch {
			setActionFeedback({ tone: "warning", message: `${pickupReference(order)}${uiCopy.merchant.shortageUnknownSuffix}` });
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
			setError(uiCopy.merchant.pushEnableFailed);
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
			setError(uiCopy.merchant.pushDisableFailed);
		} finally {
			setProcessingControl(null);
		}
	}

	function unlockForegroundAudio() {
		const controller = audioControllerRef.current;
		if (!controller || audioGestureAttempted.current) return;
		// Capture the first normal workbench gesture before its action handler.
		// Failed autoplay is non-fatal; polling must never retry activation.
		audioGestureAttempted.current = true;
		void controller.activate(false).catch(() => undefined);
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
			setError(uiCopy.merchant.availabilityFailed);
		} finally {
			setProcessingControl(null);
		}
	}

	async function changeBusyMode(busyMode: boolean) {
		if (!store || storeMutationInFlightRef.current || store.busyMode === busyMode) return;
		storeMutationInFlightRef.current = true;
		setStoreMutationInFlight(true);
		setError(null);
		const operationId = crypto.randomUUID();
		try {
			const response = await fetch("/api/merchant/store/busy-mode", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					operationId,
					expectedBusyMode: store.busyMode,
					expectedStateVersion: store.stateVersion,
					busyMode,
				}),
			});
			if (!response.ok) {
				const code = await readApiErrorCode(response);
				throw new Error(code ?? "BUSY_MODE_UPDATE_FAILED");
			}
			const result = await response.json() as { extendedOrderCount: number };
			await refreshStoreAfterOperation();
			setRefreshVersion((current) => current + 1);
			setActionFeedback({
				tone: "success",
				message: busyMode
					? `${uiCopy.merchant.busyFeedback}${result.extendedOrderCount > 0 ? `${uiCopy.merchant.busyExtendedPrefix}${result.extendedOrderCount}${uiCopy.merchant.busyExtendedSuffix}` : ""}`
					: uiCopy.merchant.normalModeRestored,
			});
		} catch {
			setError(uiCopy.merchant.busyModeFailed);
			try { await refreshStoreAfterOperation(); } catch { /* disconnected state is shown by polling */ }
		} finally {
			storeMutationInFlightRef.current = false;
			setStoreMutationInFlight(false);
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
					? uiCopy.merchant.pauseNotEffective
					: uiCopy.merchant.pauseUnknown,
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
				`${uiCopy.merchant.resumeConfirmationPrefix}${lastSync}${uiCopy.merchant.resumeConfirmationSuffix}`,
			);
			if (!confirmed) return;

			const operationId = crypto.randomUUID();
			const result = await postStoreOperation("resume", operationId, fresh);
			applyOperationResult(result);
			await refreshStoreAfterOperation();
		} catch {
			setError(uiCopy.merchant.resumeBlocked);
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
			setError(uiCopy.merchant.pushRetryFailed);
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
	const todayBusinessDate = getStoreBusinessDate();
	const historyDates = listStoreBusinessDates();
	const secondarySurfaceOpen = historyPanelOpen || revenuePanelOpen;
	useEffect(() => {
		if (window.location.pathname === "/merchant/history") void openHistoryPanel();
		else if (window.location.pathname === "/merchant/revenue") void openRevenuePanel();
		// Route-derived initialization runs once; polling owns later data refreshes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	return (
		<main className={`merchant-page${largeText ? " large-text" : ""}${secondarySurfaceOpen ? " secondary-surface" : ""}`} onClickCapture={unlockForegroundAudio} onTouchEndCapture={unlockForegroundAudio}>
			<header className="merchant-header">
				<div>
					<p className="eyebrow">{uiCopy.common.brand}</p>
					<h1>{uiCopy.merchant.title}</h1>
					<p>{uiCopy.merchant.pending} {pendingOrders.length} {uiCopy.merchant.preparingCountSeparator} {acceptedOrders.length} {uiCopy.common.orderUnit}</p>
				</div>
				<div className="merchant-header-actions">
					{connectionState !== "connected" && <div className={`merchant-compact-connection ${connectionState}`} aria-label={uiCopy.merchant.connection} aria-live="polite">
						<span className="status-dot offline" />
						<strong>{connectionState === "connecting" ? uiCopy.merchant.connecting : uiCopy.merchant.disconnected}</strong>
						{connectionState === "disconnected" && <small>{uiCopy.merchant.lastSync} {lastSyncAt ? formatDateTime(lastSyncAt.toISOString()) : uiCopy.merchant.notSynced}</small>}
					</div>}
					{secondarySurfaceOpen ? (
						<button type="button" className="merchant-history-link" onClick={returnToWorkbench}>{uiCopy.merchant.backToWorkbench}</button>
					) : <>
						<button type="button" className="merchant-history-link" aria-expanded={historyPanelOpen} onClick={() => void openHistoryPanel()}>{uiCopy.merchant.history}</button>
						<button type="button" className="merchant-revenue-link" onClick={() => void openRevenuePanel()}>{uiCopy.merchant.revenue}</button>
					</>}
					{!secondarySurfaceOpen && <button
						type="button"
						className="merchant-large-text-toggle"
						aria-pressed={largeText}
						onClick={() => setLargeText((current) => !current)}
					>
						{uiCopy.merchant.largeText}
					</button>}
				</div>
			</header>

			<MerchantPrimaryNavigation
				activeView={activeView}
				workflowView={workflowView}
				pendingCount={pendingOrders.length}
				acceptedCount={acceptedOrders.length}
				onChange={(next) => {
					if (next === "pending") navigation.returnToRoot();
					else navigation.open(next, "/merchant");
				}}
			/>

			{store && (
				<section
					className={`merchant-store-status-panel ${store.is_accepting_orders ? "accepting" : "paused"}`}
					aria-label={uiCopy.merchant.storeState}
					data-testid="store-control"
				>
					<div>
						<span className="merchant-store-state-label">
							<span className="merchant-store-state-dot" aria-hidden="true" />
							<strong>{store.is_accepting_orders ? uiCopy.merchant.storeAccepting : uiCopy.merchant.storePaused}</strong>
						</span>
						<small className="store-sync-status">
							{uiCopy.merchant.stateVersion} {store.stateVersion}{uiCopy.merchant.stateLastSync} {lastSyncAt ? formatDateTime(lastSyncAt.toISOString()) : uiCopy.merchant.notSynced}
							{lastStoreOperation ? `${uiCopy.merchant.recentOperationPrefix}${lastStoreOperation.outcome}` : ""}
						</small>
						{store.autoPauseReason === "missed_orders" && <strong className="merchant-auto-pause-reason">{uiCopy.merchant.autoPaused}</strong>}
						<span className="merchant-busy-state">{uiCopy.merchant.preparationMode}<strong>{store.busyMode ? uiCopy.merchant.busyMode : uiCopy.merchant.normalMode}</strong></span>
					</div>
					<div className="merchant-store-actions">
						<button
							type="button"
							className="busy-mode-button"
							aria-pressed={store.busyMode}
							disabled={storeMutationInFlight}
							onClick={() => void changeBusyMode(!store.busyMode)}
						>
							{storeMutationInFlight ? uiCopy.common.processing : store.busyMode ? uiCopy.merchant.switchNormal : uiCopy.merchant.switchBusy}
						</button>
						<button
							type="button"
							className="pause-store-button"
							hidden={!store.is_accepting_orders}
							disabled={storeMutationInFlight || !store.is_accepting_orders}
							onClick={() => void pauseStore()}
						>
							{storeMutationInFlight ? uiCopy.common.processing : uiCopy.merchant.pause}
						</button>
						<button
							type="button"
							className="resume-store-button"
							hidden={store.is_accepting_orders}
							disabled={storeMutationInFlight || store.is_accepting_orders || !merchantAccessHealthy}
							onClick={() => void resumeStore()}
						>
							{storeMutationInFlight ? uiCopy.common.processing : uiCopy.merchant.resume}
						</button>
					</div>
				</section>
			)}

			{isRinging && <div className="merchant-message merchant-alert-control" role="status">
				<span>{uiCopy.merchant.ringing}</span>{" "}
				<button type="button" onClick={() => audioControllerRef.current?.stopRing()}>{uiCopy.merchant.stopRing}</button>
			</div>}
			{!secondarySurfaceOpen && <section className="merchant-alert-controls" aria-label={uiCopy.merchant.orderAlerts}>
				<div className="merchant-alert-control merchant-push-control">
					<div>
						<strong>{uiCopy.merchant.notifications}</strong>
						<span aria-live="polite">
							{pushState === "enabled" ? uiCopy.merchant.pushEnabled : pushState === "checking" ? uiCopy.merchant.pushChecking : pushState === "denied" ? uiCopy.merchant.pushDenied : pushState === "unsupported" ? uiCopy.merchant.pushUnsupported : uiCopy.merchant.pushNotEnabled}
						</span>
					</div>
					{pushState !== "unsupported" && pushState !== "denied" && (
						<button
							type="button"
							disabled={processingControl !== null || pushState === "checking"}
							onClick={() => pushState === "enabled" ? void disablePushNotifications() : void enablePushNotifications()}
						>
							{pushState === "enabled" ? uiCopy.merchant.disablePush : uiCopy.merchant.enablePush}
						</button>
					)}
				</div>
				{pushState === "unsupported" && <p>{uiCopy.merchant.iphonePushHint}</p>}
				{pushState === "denied" && <p>{uiCopy.merchant.pushDeniedHint}</p>}
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
					{isLoading && <p className="merchant-message" role="status">{uiCopy.common.orderLoading}</p>}
					<section className="merchant-workbench" aria-label={uiCopy.merchant.workbench}>
						<div className="merchant-workbench-tools">
							{lastAcceptedOrderId && acceptedOrders.some((order) => order.id === lastAcceptedOrderId) && (
								<button
									type="button"
									className="recent-order-link"
									onClick={() => {
										navigation.open("accepted", "/merchant");
										window.setTimeout(() => {
											const element = document.getElementById(`merchant-order-${lastAcceptedOrderId}`);
											if (element && typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "start" });
										}, 0);
									}}
								>
									{uiCopy.merchant.viewJustAccepted}
								</button>
							)}
						</div>

						{workflowView === "pending" && (
							<section className="merchant-workflow-panel" aria-labelledby="pending-orders-heading">
								<header className="merchant-workflow-heading">
									<div><h2 id="pending-orders-heading">{uiCopy.merchant.pending}</h2><p>{uiCopy.merchant.pendingSortPrefix} {pendingOrders.length} {uiCopy.common.orderUnit}</p></div>
								</header>

								{!isLoading && pendingOrders.length === 0 && (
									<div className="merchant-empty-workflow">
										<strong>{uiCopy.merchant.noPending}</strong>
										<p>{uiCopy.merchant.noPendingHint}</p>
										<button type="button" onClick={() => navigation.open("accepted", "/merchant")}>{uiCopy.merchant.viewPreparing}</button>
									</div>
								)}

								{pendingOrders.length > 0 && (
									<div className="merchant-order-card-list" aria-label={uiCopy.merchant.pendingList}>
										{pendingOrders.map((order) => (
											<div id={`merchant-order-${order.id}`} key={order.id}>
												<MerchantOrderCard
													key={returnRevision}
													order={order}
													isNew={newOrderIds.has(order.id)}
													isProcessing={processingControl === `order-${order.id}`}
													processingAction={processingControl === `order-${order.id}` ? processingAction : null}
													onAction={(action) => requestOrderAction(order, action)}
													onShortage={(items) => performShortage(order, items)}
													onOpenSecondary={() => navigation.open("order-detail", "/merchant")}
													onReturn={navigation.returnToRoot}
												/>
											</div>
										))}
									</div>
								)}
							</section>
						)}

						{workflowView === "accepted" && (
							<section className="merchant-workflow-panel" aria-labelledby="accepted-orders-heading">
								<header className="merchant-workflow-heading">
									<div><h2 id="accepted-orders-heading">{uiCopy.merchant.preparing}</h2><p>{uiCopy.merchant.sortByReadyTime}</p></div>
								</header>
								{acceptedOrders.length === 0 ? (
									<div className="merchant-empty-workflow">
										<strong>{uiCopy.merchant.noPreparing}</strong>
										{pendingOrders.length > 0 && <><p>{uiCopy.merchant.pending} {pendingOrders.length} {uiCopy.common.orderUnit}</p><button type="button" onClick={navigation.returnToRoot}>{uiCopy.merchant.goToPending}</button></>}
									</div>
								) : (
									<div className="merchant-order-card-list" aria-label={uiCopy.merchant.preparingList}>
										{acceptedOrders.map((order) => (
											<div id={`merchant-order-${order.id}`} key={order.id}>
											<MerchantOrderCard
												key={returnRevision}
												order={order}
												isNew={false}
												isProcessing={processingControl === `order-${order.id}`}
												processingAction={processingControl === `order-${order.id}` ? processingAction : null}
												onAction={(action) => requestOrderAction(order, action)}
												onShortage={(items) => performShortage(order, items)}
												onOpenSecondary={() => navigation.open("order-detail", "/merchant")}
												onReturn={navigation.returnToRoot}
											/>
											</div>
										))}
									</div>
								)}
							</section>
						)}

					</section>

					{historyPanelOpen && (
						<section ref={historyListRef} className="merchant-history-panel" aria-labelledby="history-orders-heading">
							<header className="merchant-workflow-heading"><div><h2 id="history-orders-heading">{uiCopy.merchant.history}</h2><p>{formatBusinessDateLabel(selectedHistoryDate, todayBusinessDate)} {uiCopy.merchant.allOrdersSuffix}</p></div></header>
							<button className="merchant-history-date-trigger" type="button" aria-expanded={historyDatePickerOpen} onClick={() => setHistoryDatePickerOpen(true)}>
								<span>{uiCopy.merchant.date}</span><strong>{formatBusinessDateFull(selectedHistoryDate)}</strong><span aria-hidden="true">⌄</span>
							</button>
							{historyDatePickerOpen && <div className="merchant-dialog-backdrop" role="presentation">
								<section className="merchant-date-picker" role="dialog" aria-modal="true" aria-labelledby="history-date-picker-title">
									<header><h2 id="history-date-picker-title">{uiCopy.merchant.chooseDate}</h2><button type="button" aria-label={uiCopy.merchant.closeDatePicker} onClick={() => setHistoryDatePickerOpen(false)}>×</button></header>
									<div className="merchant-date-picker-list" role="listbox" aria-label={uiCopy.merchant.recentDays}>
										{historyDates.map((businessDate) => <button
											key={businessDate}
											ref={businessDate === selectedHistoryDate ? selectedHistoryDateRef : undefined}
											type="button"
											role="option"
											aria-selected={businessDate === selectedHistoryDate}
											onClick={() => { setHistoryDatePickerOpen(false); void loadHistoryDate(businessDate); }}
										>{formatBusinessDateFull(businessDate)}{businessDate === todayBusinessDate ? uiCopy.merchant.todaySuffix : ""}</button>)}
									</div>
								</section>
							</div>}
							{historyLoading ? <p role="status">{uiCopy.common.historyLoading}</p> : historyOrders.length === 0 ? (
								<div className="merchant-empty-workflow"><strong>{uiCopy.merchant.noHistory}</strong></div>
							) : (
									<ul className="merchant-history-accordion" aria-label={uiCopy.merchant.historyList}>
										{historyOrders.map((order) => (
											<li key={order.id}>
												<button type="button" aria-expanded={selectedHistoryId === order.id} onClick={() => setSelectedHistoryId((current) => current === order.id ? null : order.id)}>
													<strong>{formatTaipeiDeadlineTime(order.estimatedReadyAt) ?? uiCopy.common.timeMissing}</strong>
													<span>NT$ {order.total}<small>{order.status === "completed" ? uiCopy.merchant.completed : order.status === "cancelled" ? uiCopy.merchant.cancelled : order.status === "accepted" ? uiCopy.merchant.pickupTimeReached : uiCopy.merchant.rejected}</small></span>
												</button>
												{selectedHistoryId === order.id && <MerchantOrderCard order={order} isNew={false} isProcessing={processingControl === `order-${order.id}`} processingAction={processingControl === `order-${order.id}` ? processingAction : null} isHistorical embeddedHistory onAction={(action) => { if (action === "complete") requestOrderAction(order, action); }} />}
											</li>
										))}
									</ul>
							)}
						</section>
					)}

					{SHOW_NOTIFICATION_DELIVERY_HISTORY && <section className="merchant-notifications" aria-labelledby="notifications-heading">
						<h2 id="notifications-heading">{uiCopy.merchant.notificationStatus}</h2>
						{notifications.length === 0 ? <p>{uiCopy.merchant.noNotifications}</p> : (
							<ul>
								{notifications.map((delivery) => {
									const lastAttemptTime = delivery.lastAttemptAt ? new Date(delivery.lastAttemptAt).getTime() : null;
									const isStalePending = delivery.status === "pending" && lastAttemptTime !== null && Date.now() - lastAttemptTime >= 60_000;
									const canRetry = delivery.status === "failed" || (delivery.status === "pending" && (delivery.attemptCount === 0 || delivery.lastAttemptAt === null || isStalePending));
									return (
										<li key={delivery.id}>
											<div>
											<strong>{uiCopy.merchant.newOrderNotification}</strong>
												<span>{delivery.channel === "web_push" ? "Web Push" : uiCopy.merchant.legacyLineRecord} · {delivery.status === "sent" ? uiCopy.merchant.notificationSent : delivery.status === "failed" ? uiCopy.merchant.notificationFailed : uiCopy.merchant.notificationSending}</span>
												<small>{uiCopy.merchant.notificationAttemptsPrefix} {delivery.attemptCount} {uiCopy.merchant.notificationAttemptsUnit}</small>
											</div>
											{delivery.channel === "web_push" && canRetry && (
												<button type="button" disabled={processingControl !== null} onClick={() => retryNotification(delivery.id)}>{uiCopy.merchant.retryNotification}</button>
											)}
										</li>
									);
								})}
							</ul>
						)}
					</section>}
				</>
			)}

			{revenuePanelOpen && (
				<section className="merchant-revenue-panel" aria-labelledby="merchant-revenue-heading">
					<header className="merchant-workflow-heading"><div><h2 id="merchant-revenue-heading">{uiCopy.merchant.revenue}</h2><p>{formatBusinessDateFull(revenueSummary?.businessDate ?? todayBusinessDate)}</p></div></header>
					{revenueLoading ? <p role="status">{uiCopy.merchant.revenueLoading}</p> : revenueSummary && <>
						<div className="merchant-revenue-primary"><span>{uiCopy.merchant.todayRevenue}</span><strong>NT$ {revenueSummary.revenue}</strong><small>{uiCopy.merchant.revenueHint}</small></div>
						<dl className="merchant-revenue-metrics">
							<div><dt>{uiCopy.merchant.effectiveOrders}</dt><dd>{revenueSummary.effectiveOrderCount} {uiCopy.common.orderUnit}</dd></div>
							<div><dt>{uiCopy.merchant.averageOrder}</dt><dd>NT$ {revenueSummary.averageOrderValue}</dd></div>
							<div><dt>{uiCopy.merchant.itemsSold}</dt><dd>{revenueSummary.itemQuantity} {uiCopy.common.itemUnit}</dd></div>
							<div><dt>{uiCopy.merchant.busiestHour}</dt><dd>{revenueSummary.busiestHour ?? uiCopy.merchant.noData}</dd></div>
							<div><dt>{uiCopy.merchant.cancellations}</dt><dd>{revenueSummary.cancelledCount} {uiCopy.common.orderUnit}</dd></div>
							<div><dt>{uiCopy.merchant.rejections}</dt><dd>{revenueSummary.rejectedCount} {uiCopy.common.orderUnit}</dd></div>
						</dl>
						<section className="merchant-revenue-list"><h3>{uiCopy.merchant.topItems}</h3>{revenueSummary.topItems.length === 0 ? <p>{uiCopy.merchant.noEffectiveItems}</p> : <ol>{revenueSummary.topItems.map((item) => <li key={item.name}><span>{item.name}</span><strong>{item.quantity} {uiCopy.common.itemUnit}</strong></li>)}</ol>}</section>
						<section className="merchant-revenue-list"><h3>{uiCopy.merchant.todaySoldOut}</h3>{revenueSummary.soldOutItems.length === 0 ? <p>{uiCopy.merchant.noSoldOutItems}</p> : <ul>{revenueSummary.soldOutItems.map((item) => <li key={item.id}>{item.name}</li>)}</ul>}</section>
					</>}
				</section>
			)}

			{rejectCandidate && (
				<DestructiveConfirmationDialog
					title={uiCopy.merchant.rejectTitle}
					description={uiCopy.merchant.rejectDescription}
					dismissLabel={uiCopy.common.back}
					confirmLabel={uiCopy.merchant.rejectConfirm}
					isProcessing={processingAction === "reject"}
					onDismiss={() => { setRejectCandidate(null); navigation.returnToRoot(); }}
					onConfirm={() => {
						const order = rejectCandidate;
						setRejectCandidate(null);
						void executeOrderAction(order, "reject");
					}}
				>
						<p className="merchant-dialog-summary">
							{uiCopy.merchant.readyTimeLabel} {formatTaipeiDeadlineTime(rejectCandidate.estimatedReadyAt) ?? uiCopy.common.timeMissing}・
							{rejectCandidate.items.slice(0, 3).map((item) => `${item.name} ×${item.quantity}`).join("、")}
							{rejectCandidate.items.length > 3 ? `${uiCopy.merchant.remainingItemsPrefix}${rejectCandidate.items.length}${uiCopy.common.optionUnitSuffix}` : ""}
						</p>
				</DestructiveConfirmationDialog>
			)}

			<p className="merchant-security-note">{uiCopy.merchant.securityHint}</p>
		</main>
	);
}
