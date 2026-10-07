import { uiCopy } from "./ui-copy";
import { useCallback, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import {
	cartReducer,
	createCartLine,
	getCartItemCount,
	getCartLineSubtotal,
	getCartTotal,
	getActiveCartLines,
	toCheckoutItems,
	MAX_CART_LINE_QUANTITY,
	reconfigureCartLines,
	type CartLine,
	type CartAction,
} from "./cart";
import { CartTombstoneTimers } from "./cart-tombstones";
import {
	CART_DRAFT_STORAGE_KEY,
	restoreCartDraft,
	serializeCartDraft,
} from "./cart-draft";
import {
	BulkSpiceSelector,
	BusinessHoursPill,
	CartBar,
	CategoryTabs,
	CustomerHeader,
	InlineFoldOptionGroup,
	ProductCard,
	type ProductFoldDefinition,
} from "./CustomerComponents";
import {
	getDefaultOptionIds,
	buildCustomerMenuSections,
	getMainOptionDefinitions,
	getSpiceGroup,
	hasValidSpiceSelection,
	getSpecialOptionChoices,
	spiceChoices,
	toSelectedModifier,
	type MenuItem,
	type MenuCategory,
	type SpiceChoice,
} from "./customer-menu";
import CustomerOrderStatus from "./CustomerOrderStatus";
import { syncCustomerStickyStack } from "./customer-scroll";
import { spiceSemanticClass } from "./spice-presentation";
import { getCustomerRouteContext, useCustomerNavigation, type CustomerSurface } from "./customer-navigation";
import AdminView from "./AdminView";
import AdminStoreView from "./AdminStoreView";
import MerchantView from "./MerchantView";
import {
	hashOrderAttemptRequest,
	hasRecoverableOrderAttempt,
	ORDER_ATTEMPT_STORAGE_KEY,
	ORDER_FORM_SESSION_KEY,
	restoreCheckoutFormDraft,
	restoreOrderAttempt,
	restorePendingOrderAttemptKey,
	serializeCheckoutFormDraft,
	serializeOrderAttempt,
	type CheckoutFormDraft,
} from "./order-attempt";
import type { CustomerOrder } from "./order-status";
import { isCustomerOrderActive } from "./order-status";
import {
	readCustomerOrderHistoryTokens,
	readActiveCustomerOrderTokens,
	readCustomerOrderUpdateTokens,
	rememberActiveCustomerOrder,
	writeActiveCustomerOrderTokens,
} from "./active-customer-orders";
import {
	CUSTOMER_PHONE_ERROR_MESSAGE,
	CUSTOMER_PHONE_MAX_LENGTH,
	isValidCustomerPhone,
} from "../shared/customer-contact";
import { formatTaipeiDeadlineTime, getStoreBusinessDate } from "./taipei-time";

type StoreSettings = {
	display_name: string;
	is_accepting_orders: boolean;
	originDisclosure?: string[];
	todayIsOpen?: boolean | null;
	todayOpenAt?: string | null;
	todayCloseAt?: string | null;
	lastOrderAt?: string | null;
	customerPhoneMode?: "hidden" | "optional";
	showProductImages?: boolean;
};

type MenuResponse = {
	categories: MenuCategory[];
};

type CheckoutQuote = {
	items: Array<{
		menuItemId: number;
		name: string;
		quantity: number;
		unitPrice: number;
		lineTotal: number;
		modifiers: Array<{
			groupId: number;
			groupName: string;
			optionId: number;
			name: string;
			priceDelta: number;
		}>;
	}>;
	total: number;
	estimatedReadyAt: string;
	leadMinutes: number;
	quoteFingerprint: string;
};

const CHECKOUT_SPICE_ORDER = ["不辣", "微辣", "小辣", "中辣", "大辣"] as const;

function groupCheckoutItemsBySpice(items: CheckoutQuote["items"]) {
	const groups = new Map<string, CheckoutQuote["items"]>();
	for (const item of items) {
		const spice = item.modifiers.find(
			(modifier) => modifier.groupName === "辣度",
		)?.name ?? "無辣度選項";
		groups.set(spice, [...(groups.get(spice) ?? []), item]);
	}
	return [...groups.entries()].sort(([left], [right]) => {
		const leftIndex = CHECKOUT_SPICE_ORDER.indexOf(left as typeof CHECKOUT_SPICE_ORDER[number]);
		const rightIndex = CHECKOUT_SPICE_ORDER.indexOf(right as typeof CHECKOUT_SPICE_ORDER[number]);
		return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex) || left.localeCompare(right, "zh-Hant");
	});
}

type CheckoutLineIssueCode =
	| "UNKNOWN_ITEM"
	| "INACTIVE_ITEM"
	| "UNAVAILABLE_ITEM"
	| "INVALID_MODIFIER_OPTION"
	| "INACTIVE_MODIFIER_GROUP"
	| "INACTIVE_MODIFIER_OPTION"
	| "MISSING_REQUIRED_MODIFIER";

type CheckoutLineIssue = {
	itemIndex: number;
	menuItemId: number;
	code: CheckoutLineIssueCode;
	modifierOptionId?: number;
};

type RemovedCheckoutLine = {
	lineId: string;
	itemName: string;
	quantity: number;
	reason: string;
};

const REMOVABLE_CHECKOUT_LINE_CODES = new Set<CheckoutLineIssueCode>([
	"UNKNOWN_ITEM",
	"INACTIVE_ITEM",
	"UNAVAILABLE_ITEM",
	"INVALID_MODIFIER_OPTION",
	"INACTIVE_MODIFIER_GROUP",
	"INACTIVE_MODIFIER_OPTION",
	"MISSING_REQUIRED_MODIFIER",
]);

const CUSTOMER_NOTE_MAX_CHARACTERS = 120;

function hasControlCharacter(value: string) {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint === 10 || codePoint === 13) return false;
		return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
	});
}

function validateCustomerNote(note: string | null) {
	if (note === null) return null;
	if (hasControlCharacter(note)) return uiCopy.customer.noteControlError;
	if ([...note].length > CUSTOMER_NOTE_MAX_CHARACTERS) {
		return `${uiCopy.customer.noteLengthPrefix}${CUSTOMER_NOTE_MAX_CHARACTERS}${uiCopy.customer.noteLengthSuffix}`;
	}
	return null;
}

function formatReadyTime(estimatedReadyAt: string) {
	return formatTaipeiDeadlineTime(estimatedReadyAt) ?? uiCopy.common.readyTimeMissing;
}

function cartSnapshotsMatch(left: ReadonlyArray<CartLine>, right: ReadonlyArray<CartLine>) {
	return left.length === right.length && left.every((line, index) =>
		line.id === right[index]?.id && line.quantity === right[index]?.quantity,
	);
}

function parseCheckoutLineIssues(value: unknown): CheckoutLineIssue[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const issues: CheckoutLineIssue[] = [];
	for (const candidate of value) {
		if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
		const issue = candidate as Record<string, unknown>;
		if (
			typeof issue.itemIndex !== "number" ||
			!Number.isSafeInteger(issue.itemIndex) ||
			issue.itemIndex < 0 ||
			typeof issue.menuItemId !== "number" ||
			!Number.isSafeInteger(issue.menuItemId) ||
			typeof issue.code !== "string" ||
			!REMOVABLE_CHECKOUT_LINE_CODES.has(issue.code as CheckoutLineIssueCode) ||
			(issue.modifierOptionId !== undefined &&
				(typeof issue.modifierOptionId !== "number" || !Number.isSafeInteger(issue.modifierOptionId)))
		) {
			return null;
		}
		issues.push({
			itemIndex: issue.itemIndex,
			menuItemId: issue.menuItemId,
			code: issue.code as CheckoutLineIssueCode,
			...(issue.modifierOptionId === undefined
				? {}
				: { modifierOptionId: issue.modifierOptionId as number }),
		});
	}
	return issues;
}

function checkoutLineIssueReason(code: CheckoutLineIssueCode) {
	switch (code) {
		case "UNKNOWN_ITEM": return uiCopy.customer.itemMissing;
		case "INACTIVE_ITEM": return uiCopy.customer.itemInactive;
		case "UNAVAILABLE_ITEM": return uiCopy.customer.itemUnavailable;
		case "INVALID_MODIFIER_OPTION": return uiCopy.customer.modifierMissing;
		case "INACTIVE_MODIFIER_GROUP": return uiCopy.customer.modifierGroupInactive;
		case "INACTIVE_MODIFIER_OPTION": return uiCopy.customer.modifierInactive;
		case "MISSING_REQUIRED_MODIFIER": return uiCopy.customer.modifierRequired;
	}
}

function readCheckoutFormDraft(storageKey: string) {
	try {
		return restoreCheckoutFormDraft(sessionStorage.getItem(storageKey));
	} catch {
		return null;
	}
}

export function CustomerApp({ orderSource: initialOrderSource = "online" }: { orderSource?: "online" | "onsite" }) {
	const orderSource = initialOrderSource;
	const isOnsite = orderSource === "onsite";
	const [routeContext] = useState(() => getCustomerRouteContext(orderSource));
	const customerRootPath = routeContext.rootPath;
	const orderAttemptStorageKey = isOnsite
		? `${ORDER_ATTEMPT_STORAGE_KEY}:onsite`
		: ORDER_ATTEMPT_STORAGE_KEY;
	const orderFormStorageKey = isOnsite
		? `${ORDER_FORM_SESSION_KEY}:onsite`
		: ORDER_FORM_SESSION_KEY;
	const [initialCheckoutForm] = useState<CheckoutFormDraft | null>(() =>
		readCheckoutFormDraft(orderFormStorageKey),
	);
	const [store, setStore] = useState<StoreSettings | null>(null);
	const [menu, setMenu] = useState<MenuResponse | null>(null);
	const menuSections = useMemo(
		() => buildCustomerMenuSections(menu?.categories ?? []),
		[menu],
	);
	const [error, setError] = useState<string | null>(null);
	const [productOptionIds, setProductOptionIds] = useState<
		Record<number, Record<number, number | null>>
	>({});
	const [cart, rawDispatchCart] = useReducer(cartReducer, []);
	const initialSurface = routeContext.surface;
	const [view, setView] = useState<"menu" | "cart" | "checkout" | "orders">(initialSurface === "root" ? "menu" : initialSurface as "cart" | "checkout" | "orders");
	const [activeOrders, setActiveOrders] = useState<CustomerOrder[]>([]);
	const [historyOrders, setHistoryOrders] = useState<CustomerOrder[]>([]);
	const [historyOrdersLoading, setHistoryOrdersLoading] = useState(false);
	const [hasUnreadOrderUpdate, setHasUnreadOrderUpdate] = useState(() => {
		try { return readCustomerOrderUpdateTokens().length > 0; } catch { return false; }
	});
	const [activeOrdersLoading, setActiveOrdersLoading] = useState(false);
	const [activeCategoryId, setActiveCategoryId] = useState<number | null>(null);
	const [checkoutQuote, setCheckoutQuote] = useState<CheckoutQuote | null>(null);
	const [checkoutError, setCheckoutError] = useState<string | null>(null);
	const [removedCheckoutLines, setRemovedCheckoutLines] = useState<RemovedCheckoutLine[]>([]);
	const [isCheckoutLoading, setIsCheckoutLoading] = useState(false);
	const [customerPhone, setCustomerPhone] = useState(initialCheckoutForm?.customerPhone ?? "");
	const [customerPhoneTouched, setCustomerPhoneTouched] = useState(false);
	const [customerPhoneServerError, setCustomerPhoneServerError] = useState<string | null>(null);
	const [orderNote, setOrderNote] = useState(initialCheckoutForm?.orderNote ?? "");
	const [shortagePolicy, setShortagePolicy] = useState<"continue_available" | "cancel_entire_order" | undefined>(
		isOnsite ? undefined : initialCheckoutForm?.shortagePolicy ?? "continue_available",
	);
	const [cartDraftMessage, setCartDraftMessage] = useState<string | null>(null);
	const [bulkSpiceFeedback, setBulkSpiceFeedback] = useState<{
		choice: SpiceChoice;
		message: string;
		tone: "success" | "error";
	} | null>(null);
	const [recentlyAddedItemIds, setRecentlyAddedItemIds] = useState<ReadonlySet<number>>(
		() => new Set(),
	);
	const [isOrderSubmitting, setIsOrderSubmitting] = useState(false);
	const [orderError, setOrderError] = useState<string | null>(null);
	const [hasPendingOrderAttempt, setHasPendingOrderAttempt] = useState(() => {
		try {
			return hasRecoverableOrderAttempt(localStorage.getItem(orderAttemptStorageKey));
		} catch {
			return false;
		}
	});
	const [createdOrder, setCreatedOrder] = useState<CustomerOrder | null>(null);
	const [statusToken, setStatusToken] = useState<string | null>(null);
	const checkoutRequest = useRef<AbortController | null>(null);
	const orderRequest = useRef<AbortController | null>(null);
	const orderIdempotencyKey = useRef<string | null>(null);
	const orderSubmissionInFlight = useRef(false);
	const categorySelectionTarget = useRef<number | null>(null);
	const categoryScrollEndTimer = useRef<number | null>(null);
	const productAddFeedbackTimers = useRef<Map<number, number>>(new Map());
	const cartHydrated = useRef(false);
	const [cartReady, setCartReady] = useState(false);
	const checkoutEntryRequested = useRef(false);
	const cartStateRef = useRef(cart);
	cartStateRef.current = cart;
	const [zeroLineTimers] = useState(() => new CartTombstoneTimers((expired) => {
		const current = cartStateRef.current;
		if (!current.some((line) => line === expired && line.quantity === 0)) return;
		const next = cartReducer(current, { type: "remove", lineId: expired.id });
		cartStateRef.current = next;
		rawDispatchCart({ type: "hydrate", lines: next });
	}));
	// Reconcile timers synchronously for every mutation, including batched 0 -> 1 -> 0.
	const dispatchCart = useCallback((action: CartAction) => {
		const next = cartReducer(cartStateRef.current, action);
		zeroLineTimers.sync(next);
		cartStateRef.current = next;
		rawDispatchCart({ type: "hydrate", lines: next });
	}, [zeroLineTimers]);
	const navigation = useCustomerNavigation(orderSource, customerRootPath, initialSurface, (surface) => {
		if (surface.startsWith("status:")) {
			const token = surface.slice("status:".length);
			setStatusToken(token);
			setCreatedOrder((current) => current?.publicLookupToken === token ? current : null);
			return;
		}
		setCreatedOrder(null);
		setStatusToken(null);
		setView(surface === "root" ? "menu" : surface as "cart" | "checkout" | "orders");
		if (surface === "checkout") setCheckoutQuote(null);
		if (surface !== "checkout") {
			checkoutEntryRequested.current = false;
			checkoutRequest.current?.abort();
			checkoutRequest.current = null;
			setIsCheckoutLoading(false);
		}
	});
	function openCustomerView(next: "cart" | "checkout" | "orders") {
		navigation.open(next);
	}
	function openOrderStatus(order: CustomerOrder) {
		setCreatedOrder(order);
		navigation.open(`status:${order.publicLookupToken}`);
	}

	const handleOrderStatusChange = useCallback((updatedOrder: CustomerOrder) => {
		setCreatedOrder((current) => current?.publicLookupToken === updatedOrder.publicLookupToken ? updatedOrder : current);
		if (isCustomerOrderActive(updatedOrder)) {
			setActiveOrders((current) => [
				updatedOrder,
				...current.filter((order) => order.publicLookupToken !== updatedOrder.publicLookupToken),
			]);
			setHistoryOrders((current) => current.filter((order) => order.publicLookupToken !== updatedOrder.publicLookupToken));
		} else {
			setActiveOrders((current) => current.filter((order) => order.publicLookupToken !== updatedOrder.publicLookupToken));
			setHistoryOrders((current) => [
				updatedOrder,
				...current.filter((order) => order.publicLookupToken !== updatedOrder.publicLookupToken),
			]);
		}
		try { setHasUnreadOrderUpdate(readCustomerOrderUpdateTokens().length > 0); } catch { /* keep current badge */ }
	}, []);

	useEffect(() => {
		const controller = new AbortController();

		Promise.all([
			fetch("/api/store", { signal: controller.signal }),
			fetch("/api/menu", { signal: controller.signal }),
		])
			.then(async ([storeResponse, menuResponse]) => {
				if (!storeResponse.ok || !menuResponse.ok) {
					throw new Error("A required API request failed");
				}

				return Promise.all([
					storeResponse.json() as Promise<StoreSettings>,
					menuResponse.json() as Promise<MenuResponse>,
				]);
			})
			.then(([storeData, menuData]) => {
				setStore(storeData);
				setMenu(menuData);
			})
			.catch((requestError: unknown) => {
				if (requestError instanceof Error && requestError.name !== "AbortError") {
					setError(uiCopy.customer.menuLoadFailed);
				}
			});

		return () => controller.abort();
	}, []);

	useEffect(() => {
		const tokens = readActiveCustomerOrderTokens();
		if (tokens.length === 0) return;
		const controller = new AbortController();
		setActiveOrdersLoading(true);

		Promise.all(tokens.map(async (token) => {
			const response = await fetch(`/api/orders/by-token/${encodeURIComponent(token)}`, {
				signal: controller.signal,
				cache: "no-store",
			});
			if (response.status === 404) return null;
			if (!response.ok) throw new Error("Active Order lookup failed");
			return (await response.json() as { order: CustomerOrder }).order;
		}))
			.then((orders) => {
				for (const order of orders) if (order) rememberActiveCustomerOrder(order);
				setHasUnreadOrderUpdate(readCustomerOrderUpdateTokens().length > 0);
				const active = orders.filter(
					(order): order is CustomerOrder => Boolean(order && isCustomerOrderActive(order)),
				);
				setActiveOrders(active);
				writeActiveCustomerOrderTokens(active.map((order) => order.publicLookupToken));
			})
			.catch((requestError: unknown) => {
				if (!(requestError instanceof Error && requestError.name === "AbortError")) {
					// Keep the stored opaque tokens so a temporary outage cannot erase recovery access.
				}
			})
			.finally(() => {
				if (!controller.signal.aborted) setActiveOrdersLoading(false);
			});

		return () => controller.abort();
	}, []);

	useEffect(() => {
		const removeExpiredOrders = () => {
			setActiveOrders((current) => {
				const active = current.filter((order) => isCustomerOrderActive(order));
				if (active.length === current.length) return current;
				const expired = current.filter((order) => !isCustomerOrderActive(order));
				for (const order of expired) rememberActiveCustomerOrder(order);
				setHistoryOrders((history) => [
					...expired,
					...history.filter((order) => !expired.some((candidate) => candidate.publicLookupToken === order.publicLookupToken)),
				]);
				writeActiveCustomerOrderTokens(active.map((order) => order.publicLookupToken));
				return active;
			});
		};
		const timer = window.setInterval(removeExpiredOrders, 30_000);
		document.addEventListener("visibilitychange", removeExpiredOrders);
		return () => {
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", removeExpiredOrders);
		};
	}, []);

	useEffect(() => {
		if (view !== "orders") return;
		const tokens = readCustomerOrderHistoryTokens();
		if (tokens.length === 0) { setHistoryOrders([]); return; }
		const controller = new AbortController();
		setHistoryOrdersLoading(true);
		void Promise.all(tokens.map(async (token) => {
			const response = await fetch(`/api/orders/by-token/${encodeURIComponent(token)}`, {
				signal: controller.signal,
				cache: "no-store",
			});
			if (!response.ok) return null;
			return (await response.json() as { order: CustomerOrder }).order;
		})).then((orders) => {
			if (controller.signal.aborted) return;
			for (const order of orders) if (order) rememberActiveCustomerOrder(order);
			const recoveredActive = orders.filter(
				(order): order is CustomerOrder => Boolean(order && isCustomerOrderActive(order)),
			);
			if (recoveredActive.length > 0) {
				setActiveOrders((current) => {
					const recoveredTokens = new Set(recoveredActive.map((order) => order.publicLookupToken));
					return [...recoveredActive, ...current.filter((order) => !recoveredTokens.has(order.publicLookupToken))];
				});
			}
			const today = getStoreBusinessDate();
			setHistoryOrders(orders.filter(
				(order): order is CustomerOrder => Boolean(
					order &&
					!isCustomerOrderActive(order) &&
					getStoreBusinessDate(new Date(order.estimatedReadyAt)) === today
				),
			));
		}).finally(() => {
			if (!controller.signal.aborted) setHistoryOrdersLoading(false);
		});
		return () => controller.abort();
	}, [view]);

	useEffect(() => () => {
		checkoutRequest.current?.abort();
		orderRequest.current?.abort();
		if (categoryScrollEndTimer.current !== null) window.clearTimeout(categoryScrollEndTimer.current);
		for (const timer of productAddFeedbackTimers.current.values()) window.clearTimeout(timer);
		zeroLineTimers.clear();
	}, [zeroLineTimers]);

	useEffect(() => {
		try {
			sessionStorage.setItem(
				orderFormStorageKey,
				serializeCheckoutFormDraft({
					customerPhone,
					orderNote,
					packagingPreference: "together",
					...(shortagePolicy ? { shortagePolicy } : {}),
				}),
			);
		} catch {
			// The form remains usable in memory when session storage is unavailable.
		}
	}, [customerPhone, orderFormStorageKey, orderNote, shortagePolicy]);

	useEffect(() => {
		if (store?.customerPhoneMode !== "hidden") return;
		setCustomerPhone("");
		setCustomerPhoneTouched(false);
		setCustomerPhoneServerError(null);
	}, [store?.customerPhoneMode]);

	useEffect(() => {
		if (!menu || cartHydrated.current) return;
		cartHydrated.current = true;
		try {
			const restored = restoreCartDraft(localStorage.getItem(CART_DRAFT_STORAGE_KEY), menu.categories);
			if (restored.status === "expired" || restored.status === "invalid") {
				localStorage.removeItem(CART_DRAFT_STORAGE_KEY);
				setCartDraftMessage(
					restored.status === "expired" ? uiCopy.customer.draftExpired : uiCopy.customer.draftInvalid,
				);
				return;
			}
			if (restored.status === "restored") {
				dispatchCart({ type: "hydrate", lines: restored.lines });
				setCartDraftMessage(
					restored.skippedCount > 0
						? `${uiCopy.customer.draftSkippedPrefix}${restored.skippedCount}${uiCopy.customer.draftSkippedSuffix}`
						: uiCopy.customer.draftRestored,
				);
			}
		} catch {
			setCartDraftMessage(uiCopy.customer.draftReadFailed);
		} finally {
			setCartReady(true);
		}
	}, [menu, dispatchCart]);

	useEffect(() => {
		if (!cartHydrated.current) return;
		try {
			if (getActiveCartLines(cart).length === 0) localStorage.removeItem(CART_DRAFT_STORAGE_KEY);
			else localStorage.setItem(CART_DRAFT_STORAGE_KEY, serializeCartDraft(cart));
		} catch {
			setCartDraftMessage(uiCopy.customer.draftWriteFailed);
		}
	}, [cart]);

	useEffect(() => {
		const firstCategoryId = menuSections[0]?.id;
		if (firstCategoryId !== undefined && activeCategoryId === null) {
			setActiveCategoryId(firstCategoryId);
		}
	}, [activeCategoryId, menuSections]);

	useEffect(() => {
		document.documentElement.scrollTop = 0;
		document.body.scrollTop = 0;
	}, [view]);

	useEffect(() => {
		if (view !== "menu" || menuSections.length === 0) return;
		const stickyElements = document.querySelectorAll(".customer-header, .category-tabs");
		syncCustomerStickyStack();
		const stickyObserver = typeof ResizeObserver === "undefined"
			? null : new ResizeObserver(() => syncCustomerStickyStack());
		stickyElements.forEach((element) => stickyObserver?.observe(element));

		function updateActiveCategory(releaseProgrammaticTarget = false) {
			const stickyOffset = syncCustomerStickyStack();
			const sections = menuSections.flatMap((category) => {
				const element = document.getElementById(`category-${category.id}`);
				return element ? [{ categoryId: category.id, rect: element.getBoundingClientRect() }] : [];
			});

			if (
				sections.length === 0 ||
				sections.every(({ rect }) => rect.top === 0 && rect.bottom === 0 && rect.height === 0)
			) {
				return;
			}

			const documentHeight = document.documentElement.scrollHeight;
			const isAtPageBottom =
				window.scrollY > 0 &&
				documentHeight > 0 &&
				window.scrollY + window.innerHeight >= documentHeight - 2;

			if (categorySelectionTarget.current !== null) {
				const targetSection = sections.find(
					(section) => section.categoryId === categorySelectionTarget.current,
				);
				const targetIsLast = targetSection?.categoryId === sections[sections.length - 1]?.categoryId;
				if (
					!releaseProgrammaticTarget &&
					targetSection &&
					targetSection.rect.top > stickyOffset + 2 &&
					!(targetIsLast && isAtPageBottom)
				) {
					return;
				}
				categorySelectionTarget.current = null;
			}

			let nextActiveId = isAtPageBottom
				? sections[sections.length - 1]?.categoryId ?? null
				: sections[0]?.categoryId ?? null;
			if (!isAtPageBottom) {
				for (const section of sections) {
					// Browser zoom/device-pixel rounding can leave the target < 1px below the offset.
					if (section.rect.top <= stickyOffset + 2) nextActiveId = section.categoryId;
					else break;
				}
			}
			setActiveCategoryId((current) => current === nextActiveId ? current : nextActiveId);
		}

		function handleScroll() {
			updateActiveCategory();
			if (categoryScrollEndTimer.current !== null) window.clearTimeout(categoryScrollEndTimer.current);
			categoryScrollEndTimer.current = window.setTimeout(() => updateActiveCategory(true), 140);
		}

		function handleScrollEnd() {
			if (categoryScrollEndTimer.current !== null) window.clearTimeout(categoryScrollEndTimer.current);
			categoryScrollEndTimer.current = null;
			updateActiveCategory(true);
		}

		updateActiveCategory();
		window.addEventListener("scroll", handleScroll, { passive: true });
		window.addEventListener("scrollend", handleScrollEnd);
		window.addEventListener("resize", handleScrollEnd);
		const content = document.querySelector(".customer-menu-content");
		const observer = typeof ResizeObserver === "undefined" || !content
			? null
			: new ResizeObserver(() => updateActiveCategory());
		if (content) observer?.observe(content);
		return () => {
			window.removeEventListener("scroll", handleScroll);
			window.removeEventListener("scrollend", handleScrollEnd);
			window.removeEventListener("resize", handleScrollEnd);
			observer?.disconnect();
			stickyObserver?.disconnect();
			if (categoryScrollEndTimer.current !== null) window.clearTimeout(categoryScrollEndTimer.current);
		};
	}, [menuSections, view]);

	const cartItemCount = getCartItemCount(cart);
	const cartTotal = getCartTotal(cart);
	const customerPhoneMode = store?.customerPhoneMode ?? "optional";
	const menuItems = menu?.categories.flatMap((category) => category.items) ?? [];
	const spiceCartLines = getActiveCartLines(cart).flatMap((line) => {
		const item = menuItems.find((candidate) => candidate.id === line.menuItemId);
		const group = item ? getSpiceGroup(item) : undefined;
		const selected = group
			? line.selectedModifiers.find((modifier) => modifier.groupId === group.id)
			: undefined;
		return item && group && selected ? [{ line, item, group, selected }] : [];
	});
	const currentSpiceNames = new Set(
		spiceCartLines.map(({ selected }) => selected.optionName),
	);
	const bulkSpiceSummary = currentSpiceNames.size === 1
		? `${uiCopy.customer.consistentSpicePrefix}${[...currentSpiceNames][0]}`
		: uiCopy.customer.mixedSpice;
	const activeBulkSpiceChoice = currentSpiceNames.size === 1
		? spiceChoices.find((choice) => choice === [...currentSpiceNames][0]) ?? null
		: null;
	const bulkSpiceChoiceAvailability = Object.fromEntries(
		spiceChoices.map((choice) => {
			const supportedCount = spiceCartLines.filter(({ group }) =>
				group.options.some((option) => option.name === choice),
			).length;
			return [
				choice,
				supportedCount === 0
					? "none"
					: supportedCount === spiceCartLines.length
						? "all"
						: "partial",
			];
		}),
	) as Record<SpiceChoice, "all" | "partial" | "none">;
	const hasPepperPacket = getActiveCartLines(cart).some((line) =>
		line.selectedModifiers.some(
			(modifier) => modifier.groupName === "辣度" && modifier.optionName === "辣粉另包",
		),
	);
	const trimmedOrderNote = orderNote.trim();
	const submittedCustomerNote = hasPepperPacket && !trimmedOrderNote.includes("辣粉另包")
		? `${trimmedOrderNote ? `${trimmedOrderNote}\n` : ""}辣粉另包`
		: trimmedOrderNote || null;
	const customerNoteError = hasControlCharacter(orderNote)
		? uiCopy.customer.noteControlError
		: validateCustomerNote(submittedCustomerNote);
	const customerNoteCharacterCount = submittedCustomerNote ? [...submittedCustomerNote].length : 0;
	function getItemOptionIds(item: MenuItem) {
		const selected = { ...getDefaultOptionIds(item) };
		for (const [groupId, optionId] of Object.entries(productOptionIds[item.id] ?? {})) {
			if (optionId === null) delete selected[Number(groupId)];
			else selected[Number(groupId)] = optionId;
		}
		return selected;
	}

	function modifiersFromOptionIds(item: MenuItem, optionIds: Record<number, number>) {
		return item.modifierGroups.flatMap((group) => {
			const option = group.options.find((candidate) => candidate.id === optionIds[group.id]);
			return option ? [toSelectedModifier(group, option)] : [];
		});
	}

	function setProductOption(itemId: number, groupId: number, optionId: number | null) {
		// Product-card draft only. Size, seasoning and other identity options commit via addItem.
		setProductOptionIds((current) => ({
			...current,
			[itemId]: { ...current[itemId], [groupId]: optionId },
		}));
	}

	function getProductFolds(item: MenuItem): ProductFoldDefinition[] {
		const optionIds = getItemOptionIds(item);
		const mainFolds: ProductFoldDefinition[] = getMainOptionDefinitions(item).map(
			(definition) => {
				const selectedOption = definition.group.options.find(
					(option) => option.id === optionIds[definition.group.id],
				);
				return {
					id: definition.id,
					label: definition.label,
					summary: `${definition.label}：${selectedOption?.name ?? uiCopy.common.choose}`,
					mode: "single",
					choices: definition.group.options.map((option) => ({
						id: String(option.id),
						label: option.name,
						selected: option.id === selectedOption?.id,
					})),
					onChange: (choiceId, selected) => {
						if (selected) setProductOption(item.id, definition.group.id, Number(choiceId));
					},
				};
			},
		);
		const specialChoices = getSpecialOptionChoices(item);
		if (specialChoices.length === 0) return mainFolds;

		const selectedSpecialChoices = specialChoices.filter(
			(choice) => optionIds[choice.group.id] === choice.option.id,
		);
		const specialSummary =
			selectedSpecialChoices.length === 0
				? uiCopy.customer.specialOptions
				: selectedSpecialChoices.length === 1
					? `${uiCopy.customer.specialOptionPrefix}${selectedSpecialChoices[0]?.label}`
					: `${uiCopy.customer.specialOptionsCountPrefix}${selectedSpecialChoices.length}${uiCopy.common.optionUnitSuffix}`;

		return [
			...mainFolds,
			{
				id: "special-options",
				label: uiCopy.customer.specialOptions,
				summary: specialSummary,
				mode: "multiple",
				choices: specialChoices.map((choice) => ({
					id: choice.id,
					label: choice.label,
					selected: optionIds[choice.group.id] === choice.option.id,
				})),
				onChange: (choiceId, selected) => {
					const choice = specialChoices.find((candidate) => candidate.id === choiceId);
					if (choice) {
						setProductOption(item.id, choice.group.id, selected ? choice.option.id : null);
					}
				},
			},
		];
	}

	function addItem(item: MenuItem) {
		if (!item.isAvailable) return;
		const line = createCartLine(item, modifiersFromOptionIds(item, getItemOptionIds(item)));
		if (!hasValidSpiceSelection(item, line.selectedModifiers)) {
			setCartDraftMessage(uiCopy.customer.spiceConfigMissing);
			return;
		}
		const currentCart = cartStateRef.current;
		const nextCart = cartReducer(currentCart, { type: "add", line });
		if (getCartItemCount(nextCart) === getCartItemCount(currentCart)) {
			const productTimer = productAddFeedbackTimers.current.get(item.id);
			if (productTimer !== undefined) window.clearTimeout(productTimer);
			productAddFeedbackTimers.current.delete(item.id);
			setRecentlyAddedItemIds((current) => {
				const next = new Set(current);
				next.delete(item.id);
				return next;
			});
			setCartDraftMessage(`${uiCopy.customer.addLimitPrefix}${MAX_CART_LINE_QUANTITY}${uiCopy.customer.addLimitSuffix}`);
			return;
		}
		cartStateRef.current = nextCart;
		dispatchCart({ type: "hydrate", lines: nextCart });
		setCartDraftMessage(null);
		setRecentlyAddedItemIds((current) => new Set(current).add(item.id));
		const previousTimer = productAddFeedbackTimers.current.get(item.id);
		if (previousTimer !== undefined) window.clearTimeout(previousTimer);
		productAddFeedbackTimers.current.set(item.id, window.setTimeout(() => {
			productAddFeedbackTimers.current.delete(item.id);
			setRecentlyAddedItemIds((current) => {
				const next = new Set(current);
				next.delete(item.id);
				return next;
			});
		}, 240));
	}

	function decreaseItem(item: MenuItem) {
		if (!item.isAvailable) return;
		const line = createCartLine(item, modifiersFromOptionIds(item, getItemOptionIds(item)));
		const currentCart = cartStateRef.current;
		if (!currentCart.some((candidate) => candidate.id === line.id)) return;
		const nextCart = cartReducer(currentCart, { type: "decrease", lineId: line.id });
		cartStateRef.current = nextCart;
		dispatchCart({ type: "hydrate", lines: nextCart });
		setCartDraftMessage(null);
	}

	function applyBulkSpice(nextChoice: SpiceChoice) {
		const reconfigurations = spiceCartLines.flatMap(({ line, group }) => {
			const targetOption = group.options.find((option) => option.name === nextChoice);
			if (!targetOption) return [];

			const replacement = toSelectedModifier(group, targetOption);
			const selectedModifiers = [
				...line.selectedModifiers.filter((modifier) => modifier.groupId !== group.id),
				replacement,
			];
			return [{ lineId: line.id, selectedModifiers }];
		});
		const result = reconfigureCartLines(cart, reconfigurations);
		if (result.zeroLineConflict) {
			setBulkSpiceFeedback({ choice: nextChoice, tone: "error", message: uiCopy.customer.bulkZeroConflict });
			return;
		}
		if (result.exceededQuantityLimit) {
			setBulkSpiceFeedback({
				choice: nextChoice,
				message: `${uiCopy.customer.bulkLimitPrefix}${MAX_CART_LINE_QUANTITY}${uiCopy.customer.bulkLimitSuffix}`,
				tone: "error",
			});
			return;
		}
		cartStateRef.current = result.lines;
		dispatchCart({ type: "hydrate", lines: result.lines });
		setBulkSpiceFeedback({
			choice: nextChoice,
			message: bulkSpiceChoiceAvailability[nextChoice] === "partial"
				? `${uiCopy.customer.bulkAppliedPrefix}${nextChoice}${uiCopy.customer.bulkPartialSuffix}`
				: `${uiCopy.customer.bulkAppliedPrefix}${nextChoice}`,
			tone: "success",
		});
	}

	function updateLineSpice(line: CartLine, item: MenuItem, optionId: number) {
		const group = getSpiceGroup(item);
		const option = group?.options.find((candidate) => candidate.id === optionId);
		if (!group || !option) return;
		const selectedModifiers = [
				...line.selectedModifiers.filter((modifier) => modifier.groupId !== group.id),
				toSelectedModifier(group, option),
			];
		const result = reconfigureCartLines(cart, [{ lineId: line.id, selectedModifiers }]);
		if (result.zeroLineConflict) {
			setBulkSpiceFeedback({ choice: option.name as SpiceChoice, tone: "error", message: uiCopy.customer.lineZeroConflict });
			return;
		}
		if (result.exceededQuantityLimit) {
			setBulkSpiceFeedback({
				choice: option.name as SpiceChoice,
				message: `${uiCopy.customer.mergeLimitPrefix}${MAX_CART_LINE_QUANTITY}${uiCopy.customer.mergeLimitSuffix}`,
				tone: "error",
			});
			return;
		}
		cartStateRef.current = result.lines;
		dispatchCart({ type: "hydrate", lines: result.lines });
		setBulkSpiceFeedback(null);
	}

	function openCart() {
		openCustomerView("cart");
	}

	function continueShopping() {
		navigation.returnToRoot();
	}

	function reorderHistory(order: CustomerOrder) {
		if (!menu) return;
		const eligibleItems = order.reorderItems ?? [];
		const result = restoreCartDraft(JSON.stringify({
			version: 1,
			updatedAt: Date.now(),
			items: eligibleItems.map((item) => ({
				menuItemId: item.menuItemId,
				quantity: item.quantity,
				modifierOptionIds: item.modifierOptionIds,
			})),
		}), menu.categories);
		dispatchCart({ type: "hydrate", lines: result.lines });
		setCartDraftMessage(result.skippedCount > 0 || eligibleItems.length !== order.items.length
			? `${uiCopy.customer.reorderSkippedPrefix}${result.skippedCount + order.items.length - eligibleItems.length}${uiCopy.customer.reorderSkippedSuffix}`
			: uiCopy.customer.reorderConfirmHint);
		if (result.lines.length > 0) openCustomerView("cart");
		else navigation.returnToRoot();
	}

	function scrollCartToTop() {
		document.documentElement.scrollTop = 0;
		document.body.scrollTop = 0;
	}

	function selectCategory(categoryId: number) {
		categorySelectionTarget.current = categoryId;
		setActiveCategoryId(categoryId);
		const section = document.getElementById(`category-${categoryId}`);
		if (!section) return;
		const stickyOffset = syncCustomerStickyStack();
		const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
		window.scrollTo({
			top: Math.max(0, window.scrollY + section.getBoundingClientRect().top - stickyOffset),
			behavior: reduceMotion ? "auto" : "smooth",
		});
	}

	function changeCartQuantity(lineId: string, type: "increase" | "decrease") {
		const next = cartReducer(cartStateRef.current, { type, lineId });
		cartStateRef.current = next;
		dispatchCart({ type: "hydrate", lines: next });
	}

	function cartHasValidSpice(lines: ReadonlyArray<CartLine>) {
		return getActiveCartLines(lines).every((line) => {
			const item = menuItems.find((candidate) => candidate.id === line.menuItemId);
			return item && hasValidSpiceSelection(item, line.selectedModifiers);
		});
	}

	function applyCheckoutLineIssues(requestedCart: ReadonlyArray<CartLine>, value: unknown) {
		const issues = parseCheckoutLineIssues(value);
		const currentCart = cartStateRef.current;
		const requestedActive = getActiveCartLines(requestedCart);
		if (
			!issues ||
			!cartSnapshotsMatch(currentCart, requestedCart) ||
			issues.some((issue) => requestedActive[issue.itemIndex]?.menuItemId !== issue.menuItemId)
		) {
			return null;
		}

		const issueByIndex = new Map(issues.map((issue) => [issue.itemIndex, issue]));
		const removed = [...issueByIndex.entries()].map(([itemIndex, issue]) => {
			const line = requestedActive[itemIndex]!;
			return {
				lineId: line.id,
				itemName: line.itemName,
				quantity: line.quantity,
				reason: checkoutLineIssueReason(issue.code),
			};
		});
		const removedIds = new Set(removed.map((line) => line.lineId));
		const remaining = requestedCart.filter((line) => !removedIds.has(line.id));
		cartStateRef.current = remaining;
		dispatchCart({ type: "hydrate", lines: remaining });
		setRemovedCheckoutLines(removed);
		setCartDraftMessage(`${uiCopy.customer.removedCountPrefix}${removed.length}${uiCopy.customer.removedCountSuffix}`);
		return remaining;
	}

	async function loadCheckoutQuote(
		afterConfirmedChange = false,
		requestedCart: ReadonlyArray<CartLine> = cartStateRef.current,
	) {
		if (getActiveCartLines(requestedCart).length === 0 || !cartHasValidSpice(requestedCart)) {
			setCheckoutQuote(null);
			setCheckoutError(uiCopy.customer.checkoutInvalid);
			navigation.open("cart");
			return;
		}
		checkoutRequest.current?.abort();
		const controller = new AbortController();
		checkoutRequest.current = controller;
		setCheckoutQuote(null);
		setCheckoutError(null);
		setIsCheckoutLoading(true);

		try {
			const response = await fetch("/api/checkout/quote", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					items: toCheckoutItems(requestedCart),
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				const rejection = (await response.json()) as {
					error?: { code?: string; lineIssues?: unknown };
				};

				if (rejection.error?.code === "BUSINESS_HOURS_CLOSED" || rejection.error?.code === "BUSINESS_SCHEDULE_UNAVAILABLE") {
					setCheckoutError(rejection.error.code === "BUSINESS_HOURS_CLOSED" ? uiCopy.customer.businessHoursClosed : uiCopy.customer.businessScheduleUnavailable);
					return;
				}
				if (rejection.error?.code === "STORE_NOT_ACCEPTING_ORDERS") {
					setStore((current) =>
						current ? { ...current, is_accepting_orders: false } : current,
					);
					setCheckoutError(uiCopy.customer.quoteStorePaused);
					return;
				}
				if (response.status === 429) {
					const retryAfter = response.headers.get("Retry-After");
					setCheckoutError(
						retryAfter
							? `${uiCopy.customer.quoteRetryPrefix}${retryAfter}${uiCopy.customer.retrySecondsSuffix}`
							: uiCopy.customer.quoteRateLimited,
					);
					return;
				}
				if (response.status === 422 && rejection.error?.lineIssues !== undefined) {
					const remaining = applyCheckoutLineIssues(requestedCart, rejection.error.lineIssues);
					if (remaining) {
						if (getActiveCartLines(remaining).length === 0) {
							navigation.open("cart");
							return;
						}
						await loadCheckoutQuote(false, remaining);
						return;
					}
					setCheckoutError(uiCopy.customer.quoteCartChanged);
					return;
				}

				throw new Error("Checkout quote was rejected");
			}

			setCheckoutQuote((await response.json()) as CheckoutQuote);
			if (afterConfirmedChange) {
				setOrderError(uiCopy.customer.quoteChanged);
			}
		} catch (quoteError: unknown) {
			if (!(quoteError instanceof Error && quoteError.name === "AbortError")) {
				setCheckoutError(
					uiCopy.customer.quoteFailed,
				);
			}
		} finally {
			if (!controller.signal.aborted && checkoutRequest.current === controller) {
				setIsCheckoutLoading(false);
			}
		}
	}

	function openCheckout() {
		if (cartItemCount === 0 || !cartHasValidSpice(cart) || !store?.is_accepting_orders) {
			return;
		}

		openCustomerView("checkout");
		setOrderError(null);
		setCreatedOrder(null);
		setRemovedCheckoutLines([]);
		orderIdempotencyKey.current = null;
	}

	// Direct entry, refresh and Forward all re-enter checkout via the same quote
	// boundary, only after the persisted cart has actually finished hydrating.
	const quoteOnEntry = useEffectEvent(() => loadCheckoutQuote());
	useEffect(() => {
		if (view !== "checkout" || !menu || !cartReady || checkoutEntryRequested.current) return;
		checkoutEntryRequested.current = true;
		void quoteOnEntry();
	}, [view, menu, cartReady]);

	function backToCart() {
		navigation.back();
	}

	function resetSubmissionAttempt() {
		if (hasPendingOrderAttempt) return;
		orderIdempotencyKey.current = null;
		setOrderError(null);
	}

	function clearPendingOrderAttempt() {
		orderIdempotencyKey.current = null;
		setHasPendingOrderAttempt(false);
		try {
			localStorage.removeItem(orderAttemptStorageKey);
		} catch {
			// In-memory state still prevents accidental key replacement for this page.
		}
	}

	async function postOrderWithBoundedRecovery(
		endpoint: string,
		idempotencyKey: string,
		orderRequestBody: object,
	) {
		let lastResponse: Response | null = null;
		let lastError: unknown = null;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const controller = new AbortController();
			orderRequest.current = controller;
			const timeout = window.setTimeout(() => controller.abort(), 15_000);
			try {
				const response = await fetch(endpoint, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"Idempotency-Key": idempotencyKey,
					},
					body: JSON.stringify(orderRequestBody),
					signal: controller.signal,
				});
				lastResponse = response;
				if (response.status < 500 || attempt === 1) return response;
			} catch (error) {
				lastError = error;
				if (attempt === 1) throw error;
			} finally {
				window.clearTimeout(timeout);
				if (orderRequest.current === controller) orderRequest.current = null;
			}
		}
		if (lastResponse) return lastResponse;
		throw lastError instanceof Error ? lastError : new Error("Order result is unknown");
	}

	async function submitOrder(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setCustomerPhoneTouched(true);

		if (
			!checkoutQuote ||
			getActiveCartLines(cartStateRef.current).length === 0 ||
			!cartHasValidSpice(cartStateRef.current) ||
			isOrderSubmitting ||
			orderSubmissionInFlight.current ||
			(!isOnsite && customerPhoneMode === "optional" && customerPhone.trim() !== "" && !isValidCustomerPhone(customerPhone)) ||
			customerNoteError
		) {
			return;
		}

		orderSubmissionInFlight.current = true;
		setIsOrderSubmitting(true);
		setOrderError(null);
		const submittedCart = cartStateRef.current;

		try {
			const orderRequest = {
				...(!isOnsite && customerPhoneMode === "optional" && customerPhone.trim()
					? { customerPhone: customerPhone.trim() }
					: {}),
				specialOrder: false,
				customerNote: submittedCustomerNote,
				packagingPreference: "together" as const,
				...(!isOnsite ? { shortagePolicy } : {}),
				quoteFingerprint: checkoutQuote.quoteFingerprint,
				items: toCheckoutItems(submittedCart),
			};
			const requestHash = await hashOrderAttemptRequest({ orderSource, ...orderRequest });
			let idempotencyKey = orderIdempotencyKey.current;
			let storedAttempt: string | null = null;
			if (!idempotencyKey) {
				try {
					storedAttempt = localStorage.getItem(orderAttemptStorageKey);
					idempotencyKey = restoreOrderAttempt(
						storedAttempt,
						requestHash,
					);
				} catch {
					// A same-page retry still keeps the in-memory key when storage is unavailable.
				}
			}
			if (!idempotencyKey && hasRecoverableOrderAttempt(storedAttempt)) {
				// A stale client hash must not deadlock recovery. Reconcile through
				// the existing API using the original key, never a new identity.
				idempotencyKey = restorePendingOrderAttemptKey(storedAttempt);
			}
			idempotencyKey ??= crypto.randomUUID();
			orderIdempotencyKey.current = idempotencyKey;
			try {
				localStorage.setItem(
					orderAttemptStorageKey,
					serializeOrderAttempt(requestHash, idempotencyKey),
				);
				setHasPendingOrderAttempt(true);
			} catch {
				// The current page still retains the idempotency key in memory.
			}

			const response = await postOrderWithBoundedRecovery(
				isOnsite ? "/api/onsite/orders" : "/api/orders",
				idempotencyKey,
				orderRequest,
			);

			if (!response.ok) {
				let rejection: {
					error?: { code?: string; message?: string; lineIssues?: unknown };
				} = {};
				try {
					rejection = (await response.json()) as typeof rejection;
				} catch {
					// A malformed error response is an unknown outcome and keeps the same key.
				}
				const code = rejection.error?.code;

				if (response.status === 429) {
					clearPendingOrderAttempt();
					const retryAfter = response.headers.get("Retry-After");
					setOrderError(
						retryAfter
							? `${uiCopy.customer.orderRetryPrefix}${retryAfter}${uiCopy.customer.retrySecondsSuffix}`
							: uiCopy.customer.orderRateLimited,
					);
					return;
				}

				if (code === "IDEMPOTENCY_KEY_CONFLICT") {
					setOrderError(uiCopy.customer.attemptMismatch);
					return;
				}

				if (response.status >= 400 && response.status < 500) {
					clearPendingOrderAttempt();
					if (code === "INVALID_CUSTOMER_PHONE") {
						setCustomerPhoneTouched(true);
						setCustomerPhoneServerError(CUSTOMER_PHONE_ERROR_MESSAGE);
						return;
					}
					if (code === "QUOTE_CHANGED") {
						await loadCheckoutQuote(true);
						return;
					}
					if (response.status === 422 && rejection.error?.lineIssues !== undefined) {
						const remaining = applyCheckoutLineIssues(
							submittedCart,
							rejection.error.lineIssues,
						);
						if (remaining) {
								if (getActiveCartLines(remaining).length === 0) {
								setView("cart");
								return;
							}
							await loadCheckoutQuote(false, remaining);
							return;
						}
						setOrderError(
							uiCopy.customer.orderCartChanged,
						);
						return;
					}
					if (code === "BUSINESS_HOURS_CLOSED" || code === "BUSINESS_SCHEDULE_UNAVAILABLE") {
						setOrderError(code === "BUSINESS_HOURS_CLOSED" ? uiCopy.customer.businessHoursClosed : uiCopy.customer.businessScheduleUnavailable);
						return;
					}
					if (code === "STORE_NOT_ACCEPTING_ORDERS") {
						setStore((current) =>
							current ? { ...current, is_accepting_orders: false } : current,
						);
						setOrderError(uiCopy.customer.orderStorePaused);
						return;
					}
					setOrderError(
						uiCopy.customer.orderRejected,
					);
					return;
				}

				setOrderError(uiCopy.customer.orderUnknown);
				return;
			}

			const result = (await response.json()) as { order: CustomerOrder };
			let authoritativeOrder = result.order;
			try {
				const lookupResponse = await fetch(
					`/api/orders/by-token/${encodeURIComponent(result.order.publicLookupToken)}`,
					{ cache: "no-store" },
				);
				if (lookupResponse.ok) {
					const lookupResult = (await lookupResponse.json()) as { order: CustomerOrder };
					authoritativeOrder = lookupResult.order;
				}
			} catch {
				// Order creation is already confirmed; status polling will reconcile later.
			}
			dispatchCart({ type: "clear" });
			try {
				localStorage.removeItem(CART_DRAFT_STORAGE_KEY);
				localStorage.removeItem(orderAttemptStorageKey);
				sessionStorage.removeItem(orderFormStorageKey);
			} catch {
				// The submitted order is authoritative even if browser storage is unavailable.
			}
			orderIdempotencyKey.current = null;
			setHasPendingOrderAttempt(false);
			try {
				rememberActiveCustomerOrder(authoritativeOrder);
			} catch {
				// The result page remains available even if persistent storage is unavailable.
			}
			setActiveOrders((current) => [
				authoritativeOrder,
				...current.filter((order) => order.publicLookupToken !== authoritativeOrder.publicLookupToken),
			]);
			openOrderStatus(authoritativeOrder);
		} catch {
			if (orderIdempotencyKey.current) {
				setHasPendingOrderAttempt(true);
				setOrderError(uiCopy.customer.orderUnknown);
			} else {
				setOrderError(uiCopy.customer.orderPreparationFailed);
			}
		} finally {
			orderSubmissionInFlight.current = false;
			setIsOrderSubmitting(false);
		}
	}

	if (createdOrder || statusToken) {
		return (
			<CustomerOrderStatus
				publicLookupToken={createdOrder?.publicLookupToken ?? statusToken!}
				initialOrder={createdOrder ?? undefined}
				backLabel={uiCopy.customer.backToOrders}
				onOrderChange={handleOrderStatusChange}
				onBack={navigation.back}
			/>
		);
	}

	if (view === "orders") {
		return (
			<main className="page customer-page customer-orders-page">
				<CustomerHeader
					displayName={store?.display_name ?? uiCopy.customer.storeLoading}
					isAcceptingOrders={store?.is_accepting_orders ?? null}
					cartItemCount={cartItemCount}
					onCartClick={openCart}
					orderMode={orderSource}
				/>
				<section className="customer-active-orders" aria-labelledby="active-orders-heading">
					<button className="back-button" type="button" onClick={navigation.returnToRoot}>{uiCopy.customer.backToMenuArrow}</button>
					<h2 id="active-orders-heading">{uiCopy.customer.myOrders}</h2>
					<h3>{uiCopy.customer.activeOrders}</h3>
					{activeOrdersLoading && <p role="status">{uiCopy.customer.ordersUpdating}</p>}
					{!activeOrdersLoading && activeOrders.length === 0 ? (
						<p>{uiCopy.customer.noActiveOrders}</p>
					) : (
						<ul>
							{activeOrders.map((order) => (
								<li key={order.publicLookupToken}>
									<div>
										<strong>{order.status === "pending" ? uiCopy.customer.pending : uiCopy.customer.preparing}</strong>
										<span>{order.orderSource === "onsite"
											? uiCopy.onsite.readyThenPickup
											: `${uiCopy.customer.pickupTimePrefix}${formatReadyTime(order.estimatedReadyAt)}`}</span>
									</div>
									<button type="button" onClick={() => openOrderStatus(order)}>{uiCopy.customer.viewOrder}</button>
								</li>
							))}
						</ul>
					)}
					<h3 id="history-orders-heading">{uiCopy.customer.todayRecentOrders}</h3>
					{historyOrdersLoading && <p role="status">{uiCopy.common.historyLoading}</p>}
					{!historyOrdersLoading && historyOrders.length === 0 ? (
						<p>{uiCopy.customer.noRecentOrders}</p>
					) : (
						<ul className="customer-history-orders">
							{historyOrders.map((order) => (
								<li key={order.publicLookupToken}>
									<div className="history-order-summary">
										<span>{uiCopy.customer.pickup} {formatReadyTime(order.estimatedReadyAt)}</span>
										<strong>{order.status === "completed" ? uiCopy.customer.completed : order.status === "cancelled" ? uiCopy.customer.cancelled : order.status === "accepted" ? uiCopy.customer.pickupTimeReached : uiCopy.customer.rejected}</strong>
										<span>NT$ {order.total}</span>
									</div>
									<ul className="history-order-items">
										{order.items.map((item, index) => <li key={`${order.publicLookupToken}-${index}`}>{item.name} × {item.quantity}</li>)}
									</ul>
									<div className="history-order-actions">
										<button type="button" onClick={() => openOrderStatus(order)}>{uiCopy.customer.viewDetails}</button>
										<button type="button" onClick={() => reorderHistory(order)}>{uiCopy.customer.reorder}</button>
									</div>
								</li>
							))}
						</ul>
					)}
				</section>
			</main>
		);
	}

	if (view === "checkout") {
		const customerPhoneError = customerPhoneTouched && customerPhone.trim() !== "" && !isValidCustomerPhone(customerPhone)
			? CUSTOMER_PHONE_ERROR_MESSAGE
			: customerPhoneServerError;

		return (
			<main className="page customer-page customer-checkout-page">
				<CustomerHeader
					displayName={store?.display_name ?? uiCopy.customer.storeLoading}
					isAcceptingOrders={store?.is_accepting_orders ?? null}
					cartItemCount={cartItemCount}
					onCartClick={backToCart}
					orderMode={orderSource}
				/>
				<section className="checkout" aria-labelledby="checkout-heading">
					<button
						className="back-button"
						type="button"
						disabled={isOrderSubmitting || hasPendingOrderAttempt}
						onClick={backToCart}
					>
						{uiCopy.customer.backToCartArrow}
					</button>
					<p className="eyebrow checkout-eyebrow">{uiCopy.customer.goToCheckout}</p>
					<h2 id="checkout-heading">{uiCopy.customer.checkout}</h2>

					{isCheckoutLoading && (
						<p className="message" role="status">
							{uiCopy.customer.quoteLoading}
						</p>
					)}

					{checkoutError && (
						<p className="message error" role="alert">
							{checkoutError}
						</p>
					)}
					{removedCheckoutLines.length > 0 && (
						<section className="checkout-removal-notice" aria-label={uiCopy.customer.removedItems} role="status">
							<strong>{uiCopy.customer.cartUpdated}</strong>
							<ul>
								{removedCheckoutLines.map((line) => (
									<li key={line.lineId}>
										{line.itemName} × {line.quantity}：{line.reason}
									</li>
								))}
							</ul>
							<p>{uiCopy.customer.removalReconfirmHint}</p>
						</section>
					)}

					{checkoutQuote && (
						<>
							<div className="quote-spice-groups">
								{groupCheckoutItemsBySpice(checkoutQuote.items).map(([spice, items]) => (
									<section key={spice} className={spiceSemanticClass(spice)}>
										<h3>{spice}</h3>
										<ul className="quote-lines">
											{items.map((item, index) => (
												<li key={`${item.menuItemId}-${index}`}>
													<div className="cart-line-heading">
														<strong>{item.name} × {item.quantity}</strong>
														<span>NT$ {item.lineTotal}</span>
													</div>
													{item.modifiers.some((modifier) => modifier.groupName !== "辣度") && (
														<p>{item.modifiers.filter((modifier) => modifier.groupName !== "辣度").map((modifier) => modifier.name).join(" / ")}</p>
													)}
													<small>{uiCopy.customer.unitPricePrefix} {item.unitPrice}</small>
												</li>
											))}
										</ul>
									</section>
								))}
							</div>

							{isOnsite ? (
								<div className="onsite-checkout-notice">
									<strong>{uiCopy.onsite.title}</strong>
									<span>{uiCopy.onsite.checkoutHint}</span>
								</div>
							) : (
								<div className="ready-time">
									<span>{uiCopy.customer.readyTime}</span>
									<strong>{formatReadyTime(checkoutQuote.estimatedReadyAt)}</strong>
									<small>{uiCopy.customer.quoteLeadPrefix} {checkoutQuote.leadMinutes} {uiCopy.customer.minuteUnit}</small>
								</div>
							)}

							<p className="quote-total">
								<span>{uiCopy.customer.amountDue}</span>
								<strong>NT$ {checkoutQuote.total}</strong>
							</p>
							<p className="quote-note">
								{isOnsite
									? uiCopy.onsite.quoteDisclaimer
									: uiCopy.customer.quoteDisclaimer}
							</p>

							<form className="customer-form" noValidate onSubmit={submitOrder}>
								{!isOnsite && customerPhoneMode === "optional" && <label>
									<span>{uiCopy.customer.phoneLabel}</span>
									<input
										type="tel"
										inputMode="numeric"
										autoComplete="tel-national"
										maxLength={CUSTOMER_PHONE_MAX_LENGTH}
										aria-invalid={Boolean(customerPhoneError)}
										aria-describedby={customerPhoneError ? "customer-phone-error" : undefined}
										disabled={isOrderSubmitting || hasPendingOrderAttempt}
										value={customerPhone}
										onBlur={() => setCustomerPhoneTouched(true)}
										onChange={(event) => {
											setCustomerPhone(event.target.value);
											setCustomerPhoneServerError(null);
											resetSubmissionAttempt();
										}}
									/>
									{customerPhoneError && (
										<small id="customer-phone-error" className="field-error" role="alert">
											{customerPhoneError}
										</small>
									)}
									<small>{uiCopy.customer.phoneHint}</small>
								</label>}
								<label className="order-note-field">
									<span>{uiCopy.customer.noteLabel}</span>
									<textarea
										disabled={isOrderSubmitting || hasPendingOrderAttempt}
										placeholder={uiCopy.customer.notePlaceholder}
										value={orderNote}
										onChange={(event) => {
											setOrderNote(event.target.value);
											resetSubmissionAttempt();
										}}
									/>
									<small>{uiCopy.customer.notePaidOptionsHint}</small>
									{hasPepperPacket && (
										<small>{uiCopy.customer.notePacketHint}</small>
									)}
									<small>{customerNoteCharacterCount} / {CUSTOMER_NOTE_MAX_CHARACTERS} {uiCopy.common.characterUnit}</small>
									{customerNoteError && <small className="note-error" role="alert">{customerNoteError}</small>}
								</label>
								{!isOnsite && <fieldset className="shortage-policy-fieldset">
									<legend>{uiCopy.customer.shortageTitle}</legend>
									<label>
										<input
											type="radio"
											name="shortage-policy"
											value="continue_available"
											checked={shortagePolicy === "continue_available"}
											disabled={isOrderSubmitting || hasPendingOrderAttempt}
											onChange={() => {
												setShortagePolicy("continue_available");
												resetSubmissionAttempt();
											}}
										/>
										<span><strong>{uiCopy.customer.shortageContinue}</strong><small>{uiCopy.customer.shortageContinueHint}</small></span>
									</label>
									<label>
										<input
											type="radio"
											name="shortage-policy"
											value="cancel_entire_order"
											checked={shortagePolicy === "cancel_entire_order"}
											disabled={isOrderSubmitting || hasPendingOrderAttempt}
											onChange={() => {
												setShortagePolicy("cancel_entire_order");
												resetSubmissionAttempt();
											}}
										/>
										<span><strong>{uiCopy.customer.shortageCancel}</strong><small>{uiCopy.customer.shortageCancelHint}</small></span>
									</label>
								</fieldset>}
								{orderError && (
									<p className="message error" role="alert">
										{orderError}
									</p>
								)}
				{hasPendingOrderAttempt && !isOrderSubmitting && (
					<p className="message" role="status">
						{uiCopy.customer.pendingAttemptHint}
					</p>
								)}

								<button
									className="submit-order-button"
									type="submit"
										disabled={
										isOrderSubmitting ||
										cartItemCount === 0 ||
										Boolean(customerNoteError)
									}
								>
									{isOrderSubmitting ? uiCopy.customer.orderSubmitting : uiCopy.customer.confirmOrder}
								</button>
							</form>
						</>
					)}
				</section>
			</main>
		);
	}

	if (view === "cart") {
		return (
			<main className="page customer-page customer-cart-page">
				<CustomerHeader
					displayName={store?.display_name ?? uiCopy.customer.storeLoading}
					isAcceptingOrders={store?.is_accepting_orders ?? null}
					cartItemCount={cartItemCount}
					onCartClick={scrollCartToTop}
					orderMode={orderSource}
				/>
				<section className="cart customer-cart-view" aria-labelledby="cart-heading">
					<button className="back-button" type="button" onClick={continueShopping}>
						{uiCopy.customer.continueOrdering}
					</button>
					<div className="section-heading">
						<h2 id="cart-heading">{uiCopy.customer.cart}</h2>
						<span>{cartItemCount} {uiCopy.common.cartUnit}</span>
					</div>
					{cartDraftMessage && <p className="cart-draft-message" role="status">{cartDraftMessage}</p>}
					{removedCheckoutLines.length > 0 && (
						<section className="checkout-removal-notice" aria-label={uiCopy.customer.removedItems} role="status">
							<strong>{uiCopy.customer.cartUpdated}</strong>
							<ul>
								{removedCheckoutLines.map((line) => (
									<li key={line.lineId}>
										{line.itemName} × {line.quantity}：{line.reason}
									</li>
								))}
							</ul>
						</section>
					)}
					{spiceCartLines.length > 0 && (
						<BulkSpiceSelector
							currentSummary={bulkSpiceSummary}
							feedback={bulkSpiceFeedback}
							activeChoice={activeBulkSpiceChoice}
							choiceAvailability={bulkSpiceChoiceAvailability}
							onApply={applyBulkSpice}
						/>
					)}
					{cart.length === 0 ? (
						<p className="empty-cart">{uiCopy.customer.emptyCart}</p>
					) : (
						<>
							<ul className="cart-lines">
								{cart.map((line) => {
									const item = menu?.categories
										.flatMap((category) => category.items)
										.find((candidate) => candidate.id === line.menuItemId);
									const spiceGroup = item ? getSpiceGroup(item) : undefined;
									const spiceModifier = spiceGroup
										? line.selectedModifiers.find((modifier) => modifier.groupId === spiceGroup.id)
										: undefined;
									const otherModifiers = line.selectedModifiers.filter(
										(modifier) => modifier.groupId !== spiceGroup?.id,
									);

									return <li key={line.id} className={line.quantity === 0 ? "is-zero-quantity" : undefined}>
										<div className="cart-line-heading">
											<strong>{line.itemName} × {line.quantity}</strong>
											<span>NT$ {getCartLineSubtotal(line)}</span>
										</div>
										{line.quantity === 0 && <p className="zero-quantity-note">{uiCopy.customer.zeroQuantityHint}</p>}
										{otherModifiers.length > 0 && (
											<p>{otherModifiers.map((modifier) => modifier.optionName).join(" / ")}</p>
										)}
										{item && spiceGroup && spiceModifier && (
											<InlineFoldOptionGroup
												disabled={line.quantity === 0}
												label="辣度"
												summary={`辣度：${spiceModifier.optionName}`}
												mode="single"
												choices={spiceGroup.options.map((option) => ({
													id: String(option.id),
													label: option.name,
													selected: option.id === spiceModifier.optionId,
												}))}
												onChange={(choiceId, selected) => {
													if (selected) updateLineSpice(line, item, Number(choiceId));
												}}
											/>
										)}
										<div className="cart-line-actions">
											<button
												type="button"
												disabled={line.quantity === 0}
												aria-label={`${uiCopy.customer.decreasePrefix}${line.itemName}${uiCopy.customer.quantitySuffix}`}
												onClick={() => changeCartQuantity(line.id, "decrease")}
											>
												−
											</button>
											<span aria-label={`${line.itemName}${uiCopy.customer.quantitySeparator}${line.quantity}`}>{line.quantity}</span>
											<button
												type="button"
												disabled={line.quantity >= MAX_CART_LINE_QUANTITY}
												aria-label={`${uiCopy.customer.increasePrefix}${line.itemName}${uiCopy.customer.quantitySuffix}`}
												onClick={() => changeCartQuantity(line.id, "increase")}
											>
												+
											</button>
										</div>
									</li>;
								})}
							</ul>
							<p className="cart-total">
								<span>{uiCopy.customer.total}</span>
								<strong>NT$ {cartTotal}</strong>
							</p>
							<button
								className="checkout-button"
								type="button"
								disabled={cartItemCount === 0 || !cartHasValidSpice(cart) || !store?.is_accepting_orders}
								onClick={openCheckout}
							>
								{store?.is_accepting_orders ? uiCopy.customer.goToCheckout : uiCopy.customer.currentlyPaused}
							</button>
						</>
					)}
				</section>
			</main>
		);
	}

	return (
		<main className={`page customer-page${isOnsite ? " onsite-ordering" : ""}${cartItemCount > 0 ? " has-cart-bar" : ""}`}>
			<CustomerHeader
				displayName={store?.display_name ?? uiCopy.customer.storeLoading}
				isAcceptingOrders={store?.is_accepting_orders ?? null}
				cartItemCount={cartItemCount}
				onCartClick={openCart}
				activeOrderCount={activeOrders.length}
				hasUnreadOrderUpdate={hasUnreadOrderUpdate}
				onOrdersClick={() => openCustomerView("orders")}
				orderMode={orderSource}
			/>
			<BusinessHoursPill
				todayIsOpen={store?.todayIsOpen ?? null}
				todayOpenAt={store?.todayOpenAt ?? null}
				todayCloseAt={store?.todayCloseAt ?? null}
				lastOrderAt={store?.lastOrderAt ?? null}
			/>
			{menu && (
				<CategoryTabs
					categories={menuSections}
					activeCategoryId={activeCategoryId}
					onCategorySelect={selectCategory}
				/>
			)}

			{store && !store.is_accepting_orders && (
				<p className="store-paused-banner" role="status">
					<strong>{uiCopy.customer.currentlyPaused}</strong>
					<span>{uiCopy.customer.pausedMenuHint}</span>
				</p>
			)}

			{!menu && !error && (
				<p className="message" role="status">
					{uiCopy.customer.menuLoading}
				</p>
			)}
			{error && (
				<p className="message error" role="alert">
					{error}
				</p>
			)}
			{cartDraftMessage && <p className="cart-draft-message customer-draft-message" role="status">{cartDraftMessage}</p>}
			<div className="customer-menu-content">
			{menuSections.map((category) => (
				<section className="category" id={`category-${category.id}`} key={category.id}>
					<h2>{category.name}</h2>
					<ul className="menu-list">
						{[...category.items]
							.sort((left, right) => Number(right.isAvailable) - Number(left.isAvailable))
							.map((item) => {
								const selectedModifiers = modifiersFromOptionIds(item, getItemOptionIds(item));
								const selectedLine = createCartLine(item, selectedModifiers);
								const selectedQuantity = cart.find((line) => line.id === selectedLine.id)?.quantity ?? 0;
								return (
									<ProductCard
										key={item.id}
										item={item}
										folds={getProductFolds(item)}
										displayPrice={item.price + selectedModifiers.reduce((total, modifier) => total + modifier.priceDelta, 0)}
										onAdd={() => addItem(item)}
										onDecrease={() => decreaseItem(item)}
										quantity={selectedQuantity}
										isRecentlyAdded={recentlyAddedItemIds.has(item.id)}
										showImage={store?.showProductImages ?? true}
									/>
								);
							})}
					</ul>
				</section>
			))}

			{store?.originDisclosure && store.originDisclosure.length > 0 && (
				<aside className="origin-disclosure" aria-label={uiCopy.customer.originDisclosure}>
					<h2>{uiCopy.customer.originDisclosure}</h2>
					{store.originDisclosure.map((label) => <p key={label}>{label}</p>)}
				</aside>
			)}
			</div>

			<CartBar itemCount={cartItemCount} total={cartTotal} onClick={openCart} />
		</main>
	);
}

function CustomerOrderRoute({ token }: { token: string }) {
	const [source, setSource] = useState<"online" | "onsite">(() =>
		new URLSearchParams(window.location.search).get("source") === "onsite" ? "onsite" : "online");
	const [parentSurface, setParentSurface] = useState<CustomerSurface | null>(null);
	const context = getCustomerRouteContext(source);
	const navigation = useCustomerNavigation(source, context.rootPath, `status:${token}`, (surface) => setParentSurface(surface), parentSurface === null);
	return parentSurface !== null ? <CustomerApp orderSource={source} /> : <CustomerOrderStatus
		publicLookupToken={token}
		backLabel={uiCopy.customer.backToOrders}
		onBack={navigation.back}
			onOrderChange={(order) => {
				if (order.orderSource === "online" || order.orderSource === "onsite") setSource(order.orderSource);
			}}
	/>;
}

function App() {
	if (window.location.pathname === "/admin/store") {
		return <AdminStoreView />;
	}
	if (window.location.pathname === "/admin" || window.location.pathname === "/admin/menu") {
		return <AdminView />;
	}

	if (["/merchant", "/merchant/history", "/merchant/revenue"].includes(window.location.pathname)) {
		return <MerchantView />;
	}

	if (/^\/(?:store-order|onsite)(?:\/(?:cart|checkout|orders))?$/.test(window.location.pathname)) {
		return <CustomerApp orderSource="onsite" />;
	}

	if (/^\/order(?:\/(?:cart|checkout|orders))?$/.test(window.location.pathname)) {
		return <CustomerApp orderSource="online" />;
	}

	const orderRoute = window.location.pathname.match(/^\/orders\/([^/]+)$/);

	return orderRoute ? (
		<CustomerOrderRoute token={orderRoute[1]} />
	) : (
		<CustomerApp />
	);
}

export default App;
