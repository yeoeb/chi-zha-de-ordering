import { useCallback, useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import {
	cartReducer,
	createCartLine,
	getCartItemCount,
	getCartLineSubtotal,
	getCartTotal,
	MAX_CART_LINE_QUANTITY,
	reconfigureCartLines,
	type CartLine,
} from "./cart";
import {
	CART_DRAFT_STORAGE_KEY,
	restoreCartDraft,
	revalidateCartLine,
	serializeCartDraft,
} from "./cart-draft";
import {
	BulkSpiceSelector,
	CartBar,
	CategoryTabs,
	CustomerHeader,
	InlineFoldOptionGroup,
	ProductCard,
	type ProductFoldDefinition,
} from "./CustomerComponents";
import {
	getDefaultOptionIds,
	getMainOptionDefinitions,
	getSpiceGroup,
	getSpecialOptionChoices,
	spiceChoices,
	toSelectedModifier,
	type MenuItem,
	type MenuCategory,
	type SpiceChoice,
} from "./customer-menu";
import CustomerOrderStatus from "./CustomerOrderStatus";
import AdminView from "./AdminView";
import MerchantView from "./MerchantView";
import {
	hashOrderAttemptRequest,
	hasRecoverableOrderAttempt,
	ORDER_ATTEMPT_STORAGE_KEY,
	ORDER_FORM_SESSION_KEY,
	restoreCheckoutFormDraft,
	restoreOrderAttempt,
	serializeCheckoutFormDraft,
	serializeOrderAttempt,
	type CheckoutFormDraft,
} from "./order-attempt";
import type { CustomerOrder } from "./order-status";
import { shouldPollOrderStatus } from "./order-status";
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
import { formatTaipeiDeadlineTime, formatTaipeiOrderDate } from "./taipei-time";

type StoreSettings = {
	display_name: string;
	is_accepting_orders: boolean;
	originDisclosure?: string[];
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
	if (hasControlCharacter(note)) return "備註不可包含控制字元。";
	if ([...note].length > CUSTOMER_NOTE_MAX_CHARACTERS) {
		return `備註不可超過 ${CUSTOMER_NOTE_MAX_CHARACTERS} 個字。`;
	}
	return null;
}

function formatReadyTime(estimatedReadyAt: string) {
	return formatTaipeiDeadlineTime(estimatedReadyAt) ?? "預計完成時間未記錄";
}

function toCheckoutItems(lines: ReadonlyArray<CartLine>) {
	return lines.map((line) => ({
		menuItemId: line.menuItemId,
		quantity: line.quantity,
		modifierOptionIds: line.selectedModifiers.map((modifier) => modifier.optionId),
	}));
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
		case "UNKNOWN_ITEM": return "商品已不存在";
		case "INACTIVE_ITEM": return "商品已停用或封存";
		case "UNAVAILABLE_ITEM": return "商品已售完";
		case "INVALID_MODIFIER_OPTION": return "餐點選項已不存在或不屬於此商品";
		case "INACTIVE_MODIFIER_GROUP": return "餐點選項群組已停用";
		case "INACTIVE_MODIFIER_OPTION": return "餐點選項已停用";
		case "MISSING_REQUIRED_MODIFIER": return "餐點目前缺少必選選項";
	}
}

function readCheckoutFormDraft(storageKey: string) {
	try {
		return restoreCheckoutFormDraft(sessionStorage.getItem(storageKey));
	} catch {
		return null;
	}
}

export function CustomerApp({ orderSource = "online" }: { orderSource?: "online" | "onsite" }) {
	const isOnsite = orderSource === "onsite";
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
	const [error, setError] = useState<string | null>(null);
	const [productOptionIds, setProductOptionIds] = useState<
		Record<number, Record<number, number | null>>
	>({});
	const [cart, dispatchCart] = useReducer(cartReducer, []);
	const [view, setView] = useState<"menu" | "cart" | "checkout" | "orders" | "history">("menu");
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
	const [customerName, setCustomerName] = useState(initialCheckoutForm?.customerName ?? "");
	const [customerPhone, setCustomerPhone] = useState(initialCheckoutForm?.customerPhone ?? "");
	const [customerPhoneTouched, setCustomerPhoneTouched] = useState(false);
	const [customerPhoneServerError, setCustomerPhoneServerError] = useState<string | null>(null);
	const [orderNote, setOrderNote] = useState(initialCheckoutForm?.orderNote ?? "");
	const [shortagePolicy, setShortagePolicy] = useState<"continue_available" | "cancel_entire_order">(
		initialCheckoutForm?.shortagePolicy ?? "continue_available",
	);
	const [cartDraftMessage, setCartDraftMessage] = useState<string | null>(null);
	const [bulkSpiceFeedback, setBulkSpiceFeedback] = useState<{
		choice: SpiceChoice;
		message: string;
		tone: "success" | "error";
	} | null>(null);
	const [addCartFeedback, setAddCartFeedback] = useState<string | null>(null);
	const [recentlyAddedItemIds, setRecentlyAddedItemIds] = useState<ReadonlySet<number>>(
		() => new Set(),
	);
	const [removedLine, setRemovedLine] = useState<CartLine | null>(null);
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
	const [orderStatusReturnView, setOrderStatusReturnView] = useState<"menu" | "orders" | "history">("menu");
	const checkoutRequest = useRef<AbortController | null>(null);
	const orderRequest = useRef<AbortController | null>(null);
	const orderIdempotencyKey = useRef<string | null>(null);
	const orderSubmissionInFlight = useRef(false);
	const categorySelectionTarget = useRef<number | null>(null);
	const categoryScrollEndTimer = useRef<number | null>(null);
	const undoTimer = useRef<number | null>(null);
	const addCartFeedbackTimer = useRef<number | null>(null);
	const productAddFeedbackTimers = useRef<Map<number, number>>(new Map());
	const cartHydrated = useRef(false);
	const cartStateRef = useRef(cart);
	cartStateRef.current = cart;

	const handleOrderStatusChange = useCallback((updatedOrder: CustomerOrder) => {
		setCreatedOrder((current) => current?.publicLookupToken === updatedOrder.publicLookupToken ? updatedOrder : current);
		if (shouldPollOrderStatus(updatedOrder.status)) {
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
					setError("目前無法載入菜單，請稍後再試。");
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
					(order): order is CustomerOrder => Boolean(order && shouldPollOrderStatus(order.status)),
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
		if (view !== "history") return;
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
				(order): order is CustomerOrder => Boolean(order && shouldPollOrderStatus(order.status)),
			);
			if (recoveredActive.length > 0) {
				setActiveOrders((current) => {
					const recoveredTokens = new Set(recoveredActive.map((order) => order.publicLookupToken));
					return [...recoveredActive, ...current.filter((order) => !recoveredTokens.has(order.publicLookupToken))];
				});
			}
			setHistoryOrders(orders.filter(
				(order): order is CustomerOrder => Boolean(order && !shouldPollOrderStatus(order.status)),
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
		if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
		if (addCartFeedbackTimer.current !== null) window.clearTimeout(addCartFeedbackTimer.current);
		for (const timer of productAddFeedbackTimers.current.values()) window.clearTimeout(timer);
	}, []);

	useEffect(() => {
		try {
			sessionStorage.setItem(
				orderFormStorageKey,
				serializeCheckoutFormDraft({
					customerName,
					customerPhone,
					orderNote,
					packagingPreference: "together",
					shortagePolicy,
				}),
			);
		} catch {
			// The form remains usable in memory when session storage is unavailable.
		}
	}, [customerName, customerPhone, orderFormStorageKey, orderNote, shortagePolicy]);

	useEffect(() => {
		if (!menu || cartHydrated.current) return;
		cartHydrated.current = true;
		try {
			const restored = restoreCartDraft(localStorage.getItem(CART_DRAFT_STORAGE_KEY), menu.categories);
			if (restored.status === "expired" || restored.status === "invalid") {
				localStorage.removeItem(CART_DRAFT_STORAGE_KEY);
				setCartDraftMessage(
					restored.status === "expired" ? "購物車草稿已過期，請重新選擇餐點。" : "購物車草稿格式異常，已安全忽略。",
				);
				return;
			}
			if (restored.status === "restored") {
				dispatchCart({ type: "hydrate", lines: restored.lines });
				setCartDraftMessage(
					restored.skippedCount > 0
						? `已依最新菜單還原購物車，另有 ${restored.skippedCount} 筆失效餐點未還原。`
						: "已依最新菜單還原購物車；結帳時會再次確認價格與供應狀態。",
				);
			}
		} catch {
			setCartDraftMessage("瀏覽器無法讀取購物車草稿，本次仍可正常點餐。");
		}
	}, [menu]);

	useEffect(() => {
		if (!cartHydrated.current) return;
		try {
			if (cart.length === 0) localStorage.removeItem(CART_DRAFT_STORAGE_KEY);
			else localStorage.setItem(CART_DRAFT_STORAGE_KEY, serializeCartDraft(cart));
		} catch {
			setCartDraftMessage("瀏覽器無法保存購物車草稿，請勿重新整理頁面。");
		}
	}, [cart]);

	useEffect(() => {
		const firstCategoryId = menu?.categories[0]?.id;
		if (firstCategoryId !== undefined && activeCategoryId === null) {
			setActiveCategoryId(firstCategoryId);
		}
	}, [activeCategoryId, menu]);

	useEffect(() => {
		document.documentElement.scrollTop = 0;
		document.body.scrollTop = 0;
	}, [view]);

	useEffect(() => {
		if (view !== "menu" || !menu || menu.categories.length === 0) return;

		function updateActiveCategory(releaseProgrammaticTarget = false) {
			const headerBottom = document.querySelector(".customer-header")?.getBoundingClientRect().bottom ?? 0;
			const tabsBottom = document.querySelector(".category-tabs")?.getBoundingClientRect().bottom ?? 0;
			const stickyOffset = Math.max(headerBottom, tabsBottom) + 24;
			const sections = menu!.categories.flatMap((category) => {
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
					if (section.rect.top <= stickyOffset) nextActiveId = section.categoryId;
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
			if (categoryScrollEndTimer.current !== null) window.clearTimeout(categoryScrollEndTimer.current);
		};
	}, [menu, view]);

	const cartItemCount = getCartItemCount(cart);
	const cartTotal = getCartTotal(cart);
	const menuItems = menu?.categories.flatMap((category) => category.items) ?? [];
	const spiceCartLines = cart.flatMap((line) => {
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
		? `全部一致：${[...currentSpiceNames][0]}`
		: "目前混合辣度";
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
	const submittedCustomerNote = orderNote.trim() || null;
	const customerNoteError = hasControlCharacter(orderNote)
		? "備註不可包含控制字元。"
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
					summary: `${definition.label}：${selectedOption?.name ?? "請選擇"}`,
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
				? "特殊選項（選填）"
				: selectedSpecialChoices.length === 1
					? `特殊選項：${selectedSpecialChoices[0]?.label}`
					: `特殊選項：已選 ${selectedSpecialChoices.length} 項`;

		return [
			...mainFolds,
			{
				id: "special-options",
				label: "特殊選項（選填）",
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
			setAddCartFeedback(null);
			setCartDraftMessage(`同一選項單筆最多 ${MAX_CART_LINE_QUANTITY} 份，請先調整購物車。`);
			return;
		}
		cartStateRef.current = nextCart;
		dispatchCart({ type: "hydrate", lines: nextCart });
		setCartDraftMessage(null);
		setAddCartFeedback(`${item.name}已加入購物車`);
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
		}, 900));
		if (addCartFeedbackTimer.current !== null) window.clearTimeout(addCartFeedbackTimer.current);
		addCartFeedbackTimer.current = window.setTimeout(() => {
			setAddCartFeedback(null);
			addCartFeedbackTimer.current = null;
		}, 1_800);
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
		if (result.exceededQuantityLimit) {
			setBulkSpiceFeedback({
				choice: nextChoice,
				message: `套用後相同餐點會超過單筆 ${MAX_CART_LINE_QUANTITY} 份，未變更任何餐點。`,
				tone: "error",
			});
			return;
		}
		dispatchCart({ type: "hydrate", lines: result.lines });
		setBulkSpiceFeedback({
			choice: nextChoice,
			message: bulkSpiceChoiceAvailability[nextChoice] === "partial"
				? `已套用${nextChoice}；部分餐點不支援，未變更。`
				: `已套用${nextChoice}`,
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
		if (result.exceededQuantityLimit) {
			setBulkSpiceFeedback({
				choice: option.name as SpiceChoice,
				message: `合併後會超過單筆 ${MAX_CART_LINE_QUANTITY} 份，請先調整數量。`,
				tone: "error",
			});
			return;
		}
		dispatchCart({ type: "hydrate", lines: result.lines });
		setBulkSpiceFeedback(null);
	}

	function openCart() {
		setView("cart");
	}

	function continueShopping() {
		setView("menu");
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
			? `已加入目前仍可購買的餐點；${result.skippedCount + order.items.length - eligibleItems.length} 項已停售或選項已變更。`
			: "已依目前菜單與價格加入購物車，請重新確認後結帳。");
		setView(result.lines.length > 0 ? "cart" : "menu");
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
		const headerBottom = document.querySelector(".customer-header")?.getBoundingClientRect().bottom ?? 0;
		const tabsHeight = document.querySelector(".category-tabs")?.getBoundingClientRect().height ?? 0;
		const stickyOffset = headerBottom + tabsHeight + 24;
		const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
		window.scrollTo({
			top: Math.max(0, window.scrollY + section.getBoundingClientRect().top - stickyOffset),
			behavior: reduceMotion ? "auto" : "smooth",
		});
	}

	function removeCartLine(line: CartLine) {
		if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
		setRemovedLine(line);
		dispatchCart({ type: "remove", lineId: line.id });
		undoTimer.current = window.setTimeout(() => setRemovedLine(null), 6_000);
	}

	function undoRemoveCartLine() {
		if (!removedLine || !menu) return;
		const restored = revalidateCartLine(removedLine, menu.categories);
		if (!restored) {
			setRemovedLine(null);
			setCartDraftMessage("餐點或選項已更新，無法安全復原，請重新選擇。");
			return;
		}
		if (cart.some((line) => line.id === restored.id)) {
			setRemovedLine(null);
			setCartDraftMessage("購物車已有相同餐點，未重複加入已移除的數量。");
			return;
		}
		dispatchCart({ type: "restore", line: restored });
		setRemovedLine(null);
		if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
	}

	function applyCheckoutLineIssues(requestedCart: ReadonlyArray<CartLine>, value: unknown) {
		const issues = parseCheckoutLineIssues(value);
		const currentCart = cartStateRef.current;
		if (
			!issues ||
			!cartSnapshotsMatch(currentCart, requestedCart) ||
			issues.some((issue) => requestedCart[issue.itemIndex]?.menuItemId !== issue.menuItemId)
		) {
			return null;
		}

		const issueByIndex = new Map(issues.map((issue) => [issue.itemIndex, issue]));
		const removed = [...issueByIndex.entries()].map(([itemIndex, issue]) => {
			const line = requestedCart[itemIndex]!;
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
		setCartDraftMessage(`購物車已移除 ${removed.length} 筆無法購買的餐點，其他餐點與選項均已保留。`);
		return remaining;
	}

	async function loadCheckoutQuote(
		afterConfirmedChange = false,
		requestedCart: ReadonlyArray<CartLine> = cartStateRef.current,
	) {
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

				if (rejection.error?.code === "STORE_NOT_ACCEPTING_ORDERS") {
					setStore((current) =>
						current ? { ...current, is_accepting_orders: false } : current,
					);
					setCheckoutError("目前暫停接單，請稍後再試。");
					return;
				}
				if (response.status === 429) {
					const retryAfter = response.headers.get("Retry-After");
					setCheckoutError(
						retryAfter
							? `報價請求過於頻繁，請於 ${retryAfter} 秒後再試。`
							: "報價請求過於頻繁，請稍後再試。",
					);
					return;
				}
				if (response.status === 422 && rejection.error?.lineIssues !== undefined) {
					const remaining = applyCheckoutLineIssues(requestedCart, rejection.error.lineIssues);
					if (remaining) {
						if (remaining.length === 0) {
							setView("cart");
							return;
						}
						await loadCheckoutQuote(false, remaining);
						return;
					}
					setCheckoutError("報價期間購物車已變更，未自動移除任何餐點；請重新確認購物車。");
					return;
				}

				throw new Error("Checkout quote was rejected");
			}

			setCheckoutQuote((await response.json()) as CheckoutQuote);
			if (afterConfirmedChange) {
				setOrderError("價格或餐點選項已更新，請確認新金額後再次確認下單。");
			}
		} catch (quoteError: unknown) {
			if (!(quoteError instanceof Error && quoteError.name === "AbortError")) {
				setCheckoutError(
					"目前無法確認最新價格。請返回購物車確認後再試。",
				);
			}
		} finally {
			if (!controller.signal.aborted && checkoutRequest.current === controller) {
				setIsCheckoutLoading(false);
			}
		}
	}

	async function openCheckout() {
		if (cart.length === 0 || !store?.is_accepting_orders) {
			return;
		}

		setView("checkout");
		setOrderError(null);
		setCreatedOrder(null);
		setRemovedCheckoutLines([]);
		orderIdempotencyKey.current = null;
		await loadCheckoutQuote();
	}

	function backToCart() {
		if (isOrderSubmitting || hasPendingOrderAttempt) {
			return;
		}

		checkoutRequest.current?.abort();
		checkoutRequest.current = null;
		orderIdempotencyKey.current = null;
		setIsCheckoutLoading(false);
		setView("cart");
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

	async function submitOrder(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setCustomerPhoneTouched(true);

		if (
			!checkoutQuote ||
			isOrderSubmitting ||
			orderSubmissionInFlight.current ||
			(!isOnsite && !customerName.trim()) ||
			(!isOnsite && !isValidCustomerPhone(customerPhone)) ||
			customerNoteError
		) {
			return;
		}

		orderSubmissionInFlight.current = true;
		setIsOrderSubmitting(true);
		setOrderError(null);
		const submittedCart = cartStateRef.current;
		const controller = new AbortController();
		orderRequest.current = controller;
		const timeout = window.setTimeout(() => controller.abort(), 15_000);

		try {
			const orderRequest = {
				...(isOnsite ? {} : { customerName, customerPhone }),
				specialOrder: false,
				customerNote: submittedCustomerNote,
				packagingPreference: "together" as const,
				shortagePolicy,
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
				setHasPendingOrderAttempt(true);
				setOrderError(
					"上次送單結果尚未確認，但目前資料與原請求不同。為避免重複訂單，請勿建立新送單識別，請聯絡店家核對。",
				);
				return;
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

			const response = await fetch(isOnsite ? "/api/onsite/orders" : "/api/orders", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": idempotencyKey,
				},
				body: JSON.stringify(orderRequest),
				signal: controller.signal,
			});

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
							? `送單過於頻繁，本次未建立訂單。請於 ${retryAfter} 秒後再試。`
							: "送單過於頻繁，本次未建立訂單。請稍後再試。",
					);
					return;
				}

				if (code === "IDEMPOTENCY_KEY_CONFLICT") {
					setOrderError(
						"送單識別與先前內容衝突。為避免重複訂單，請停止重送並聯絡店家核對。",
					);
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
							if (remaining.length === 0) {
								setView("cart");
								return;
							}
							await loadCheckoutQuote(false, remaining);
							return;
						}
						setOrderError(
							"送單期間購物車已變更，未自動移除任何餐點；本次未建立訂單，請重新確認購物車。",
						);
						return;
					}
					if (code === "STORE_NOT_ACCEPTING_ORDERS") {
						setStore((current) =>
							current ? { ...current, is_accepting_orders: false } : current,
						);
						setOrderError("店家目前暫停接單，本次未建立訂單。");
						return;
					}
					setOrderError(
						"本次未建立訂單。餐點供應或選項可能已變更，請返回購物車確認後再試。",
					);
					return;
				}

				setOrderError(
					"送單結果尚未確認。請勿重新建立訂單；稍後按原按鈕會沿用同一送單識別安全查回。",
				);
				return;
			}

			const result = (await response.json()) as { order: CustomerOrder };
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
				rememberActiveCustomerOrder(result.order);
			} catch {
				// The result page remains available even if persistent storage is unavailable.
			}
			setActiveOrders((current) => [
				result.order,
				...current.filter((order) => order.publicLookupToken !== result.order.publicLookupToken),
			]);
			setOrderStatusReturnView("menu");
			setCreatedOrder(result.order);
			window.history.replaceState(
				null,
				"",
				`/orders/${encodeURIComponent(result.order.publicLookupToken)}`,
			);
		} catch {
			if (orderIdempotencyKey.current) {
				setHasPendingOrderAttempt(true);
				setOrderError(
					"送單結果尚未確認，可能是網路中斷或回應逾時。請勿建立新訂單；稍後按原按鈕會沿用同一送單識別查回。",
				);
			} else {
				setOrderError("送單前準備失敗，本次尚未送出。請稍後再試。");
			}
		} finally {
			window.clearTimeout(timeout);
			if (orderRequest.current === controller) orderRequest.current = null;
			orderSubmissionInFlight.current = false;
			setIsOrderSubmitting(false);
		}
	}

	if (createdOrder) {
		const returnPath = orderSource === "onsite" ? "/onsite" : "/";
		return (
			<CustomerOrderStatus
				publicLookupToken={createdOrder.publicLookupToken}
				initialOrder={createdOrder}
				backLabel={orderStatusReturnView === "menu" ? "返回菜單" : orderStatusReturnView === "history" ? "返回歷史訂單" : "返回我的訂單"}
				onOrderChange={handleOrderStatusChange}
				onBack={() => {
					setCreatedOrder(null);
					setView(orderStatusReturnView);
					window.history.replaceState(null, "", returnPath);
				}}
			/>
		);
	}

	if (view === "orders") {
		return (
			<main className="page customer-page customer-orders-page">
				<CustomerHeader
					displayName={store?.display_name ?? "店家載入中…"}
					isAcceptingOrders={store?.is_accepting_orders ?? null}
					cartItemCount={cartItemCount}
					onCartClick={openCart}
					orderMode={orderSource}
				/>
				<section className="customer-active-orders" aria-labelledby="active-orders-heading">
					<button className="back-button" type="button" onClick={() => setView("menu")}>← 返回菜單</button>
					<h2 id="active-orders-heading">我的訂單</h2>
					<h3>進行中</h3>
					{activeOrdersLoading && <p role="status">正在更新訂單狀態…</p>}
					{!activeOrdersLoading && activeOrders.length === 0 ? (
						<p>目前沒有進行中的訂單。</p>
					) : (
						<ul>
							{activeOrders.map((order) => (
								<li key={order.publicLookupToken}>
									<div>
										<strong>{order.status === "pending" ? "等待店家接單" : "製作中"}</strong>
										<span>{order.orderSource === "onsite"
											? "現場點餐・完成後取餐"
											: `預計取餐 ${formatReadyTime(order.estimatedReadyAt)}`}</span>
									</div>
									<button type="button" onClick={() => {
										setOrderStatusReturnView("orders");
										setCreatedOrder(order);
										window.history.replaceState(null, "", `/orders/${encodeURIComponent(order.publicLookupToken)}`);
									}}>查看訂單</button>
								</li>
							))}
						</ul>
					)}
					<button className="history-entry-button" type="button" onClick={() => setView("history")}>
						<span><strong>歷史訂單</strong><small>查看已完成、未成立或已取消的訂單</small></span>
						<span aria-hidden="true">›</span>
					</button>
				</section>
			</main>
		);
	}

	if (view === "history") {
		return (
			<main className="page customer-page customer-orders-page">
				<CustomerHeader
					displayName={store?.display_name ?? "店家載入中…"}
					isAcceptingOrders={store?.is_accepting_orders ?? null}
					cartItemCount={cartItemCount}
					onCartClick={openCart}
					orderMode={orderSource}
				/>
				<section className="customer-active-orders" aria-labelledby="history-orders-heading">
					<button className="back-button" type="button" onClick={() => setView("orders")}>← 返回我的訂單</button>
					<h2 id="history-orders-heading">歷史訂單</h2>
					{historyOrdersLoading && <p role="status">正在載入歷史訂單…</p>}
					{!historyOrdersLoading && historyOrders.length === 0 ? (
						<p>目前沒有歷史訂單。</p>
					) : (
						<ul className="customer-history-orders">
							{historyOrders.map((order) => (
								<li key={order.publicLookupToken}>
									<div className="history-order-summary">
										<span>{formatTaipeiOrderDate(order.estimatedReadyAt) ?? "日期未記錄"}</span>
										<strong>{order.status === "completed" ? "餐點已完成" : order.status === "cancelled" ? "訂單已取消" : "訂單未成立"}</strong>
										<span>NT$ {order.total}</span>
									</div>
									<ul className="history-order-items">
										{order.items.map((item, index) => <li key={`${order.publicLookupToken}-${index}`}>{item.name} × {item.quantity}</li>)}
									</ul>
									<div className="history-order-actions">
										<button type="button" onClick={() => { setOrderStatusReturnView("history"); setCreatedOrder(order); window.history.replaceState(null, "", `/orders/${encodeURIComponent(order.publicLookupToken)}`); }}>查看明細</button>
										<button type="button" onClick={() => reorderHistory(order)}>再點一樣的</button>
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
		const customerPhoneError = customerPhoneTouched && !isValidCustomerPhone(customerPhone)
			? CUSTOMER_PHONE_ERROR_MESSAGE
			: customerPhoneServerError;

		return (
			<main className="page customer-page customer-checkout-page">
				<CustomerHeader
					displayName={store?.display_name ?? "店家載入中…"}
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
						← 返回購物車
					</button>
					<p className="eyebrow checkout-eyebrow">去結帳</p>
					<h2 id="checkout-heading">確認訂單</h2>

					{isCheckoutLoading && (
						<p className="message" role="status">
							正在確認最新價格與取餐時間…
						</p>
					)}

					{checkoutError && (
						<p className="message error" role="alert">
							{checkoutError}
						</p>
					)}
					{removedCheckoutLines.length > 0 && (
						<section className="checkout-removal-notice" aria-label="已移除的餐點" role="status">
							<strong>購物車已更新</strong>
							<ul>
								{removedCheckoutLines.map((line) => (
									<li key={line.lineId}>
										{line.itemName} × {line.quantity}：{line.reason}
									</li>
								))}
							</ul>
							<p>其他餐點與選項已保留，請確認更新後的報價再送出。</p>
						</section>
					)}

					{checkoutQuote && (
						<>
							<ul className="quote-lines">
								{checkoutQuote.items.map((item, index) => (
									<li key={`${item.menuItemId}-${index}`}>
										<div className="cart-line-heading">
											<strong>
												{item.name} × {item.quantity}
											</strong>
											<span>NT$ {item.lineTotal}</span>
										</div>
										{item.modifiers.length > 0 && (
											<p>{item.modifiers.map((modifier) => modifier.name).join(" / ")}</p>
										)}
										<small>單價 NT$ {item.unitPrice}</small>
									</li>
								))}
							</ul>

							{isOnsite ? (
								<div className="onsite-checkout-notice">
									<strong>現場點餐</strong>
									<span>送出後請留意訂單畫面；餐點完成後即可取餐。</span>
								</div>
							) : (
								<div className="ready-time">
									<span>預計完成時間</span>
									<strong>{formatReadyTime(checkoutQuote.estimatedReadyAt)}</strong>
									<small>目前網頁訂單約 {checkoutQuote.leadMinutes} 分鐘</small>
								</div>
							)}

							<p className="quote-total">
								<span>應付金額</span>
								<strong>NT$ {checkoutQuote.total}</strong>
							</p>
							<p className="quote-note">
								{isOnsite
									? "價格已由店家系統確認；現場單會依目前產能安排，不承諾特定取餐時間。"
									: "價格已由店家系統確認；時間為依目前網頁訂單估算，未包含現場或電話單。送單後可能依最新排隊情況調整，並以該筆訂單保存的預計完成時間為準。"}
							</p>

							<form className="customer-form" noValidate onSubmit={submitOrder}>
								{!isOnsite && <label>
									<span className="required-label">姓名</span>
									<input
										type="text"
										maxLength={50}
										required
										disabled={isOrderSubmitting || hasPendingOrderAttempt}
										value={customerName}
										onChange={(event) => {
											setCustomerName(event.target.value);
											resetSubmissionAttempt();
										}}
									/>
								</label>}
								{!isOnsite && <label>
									<span className="required-label">電話</span>
									<input
										type="tel"
										inputMode="numeric"
										autoComplete="tel-national"
										maxLength={CUSTOMER_PHONE_MAX_LENGTH}
										required
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
								</label>}
								<label className="order-note-field">
									<span>訂單備註（選填）</span>
									<textarea
										disabled={isOrderSubmitting || hasPendingOrderAttempt}
										placeholder="例如：不放蒜頭、炸酥一點"
										value={orderNote}
										onChange={(event) => {
											setOrderNote(event.target.value);
											resetSubmissionAttempt();
										}}
									/>
									<small>需加價的需求請使用餐點選項，請勿填在備註。</small>
									<small>{customerNoteCharacterCount} / {CUSTOMER_NOTE_MAX_CHARACTERS} 字</small>
									{customerNoteError && <small className="note-error" role="alert">{customerNoteError}</small>}
				</label>
				<fieldset className="shortage-policy-fieldset">
					<legend>如果餐點售完</legend>
					<label>
						<input type="radio" name="shortage-policy" value="continue_available"
							checked={shortagePolicy === "continue_available"}
							disabled={isOrderSubmitting || hasPendingOrderAttempt}
							onChange={() => { setShortagePolicy("continue_available"); resetSubmissionAttempt(); }} />
						<span><strong>其他餐點繼續製作</strong><small>售完品項會從應付金額扣除。</small></span>
					</label>
					<label>
						<input type="radio" name="shortage-policy" value="cancel_entire_order"
							checked={shortagePolicy === "cancel_entire_order"}
							disabled={isOrderSubmitting || hasPendingOrderAttempt}
							onChange={() => { setShortagePolicy("cancel_entire_order"); resetSubmissionAttempt(); }} />
						<span><strong>取消整筆訂單</strong><small>任何品項缺貨時，整筆都不製作。</small></span>
					</label>
				</fieldset>
				{orderError && (
									<p className="message error" role="alert">
										{orderError}
									</p>
								)}
								{hasPendingOrderAttempt && !isOrderSubmitting && (
									<p className="message" role="status">
										{isOnsite
											? "已保留原送單識別；再次送出只會查回或完成同一次現場訂單。"
											: "已保留原送單識別與本分頁的聯絡資料；再次送出只會查回或完成同一次送單。"}
									</p>
								)}

								<button
									className="submit-order-button"
									type="submit"
									disabled={
										isOrderSubmitting ||
										(!isOnsite && !customerName.trim()) ||
										Boolean(customerNoteError)
									}
								>
									{isOrderSubmitting ? "下單中…" : "確認下單"}
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
					displayName={store?.display_name ?? "店家載入中…"}
					isAcceptingOrders={store?.is_accepting_orders ?? null}
					cartItemCount={cartItemCount}
					onCartClick={scrollCartToTop}
					orderMode={orderSource}
				/>
				<section className="cart customer-cart-view" aria-labelledby="cart-heading">
					<button className="back-button" type="button" onClick={continueShopping}>
						← 繼續點餐
					</button>
					<div className="section-heading">
						<h2 id="cart-heading">購物車</h2>
						<span>{cartItemCount} 件</span>
					</div>
					{cartDraftMessage && <p className="cart-draft-message" role="status">{cartDraftMessage}</p>}
					{removedCheckoutLines.length > 0 && (
						<section className="checkout-removal-notice" aria-label="已移除的餐點" role="status">
							<strong>購物車已更新</strong>
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
						<p className="empty-cart">尚未加入餐點</p>
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

									return <li key={line.id}>
										<div className="cart-line-heading">
											<strong>{line.itemName} × {line.quantity}</strong>
											<span>NT$ {getCartLineSubtotal(line)}</span>
										</div>
										{otherModifiers.length > 0 && (
											<p>{otherModifiers.map((modifier) => modifier.optionName).join(" / ")}</p>
										)}
										{item && spiceGroup && spiceModifier && (
											<InlineFoldOptionGroup
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
												disabled={line.quantity === 1}
												aria-label={`減少 ${line.itemName} 數量`}
												onClick={() => dispatchCart({ type: "decrease", lineId: line.id })}
											>
												−
											</button>
											<span aria-label={`${line.itemName} 數量 ${line.quantity}`}>{line.quantity}</span>
											<button
												type="button"
												disabled={line.quantity >= MAX_CART_LINE_QUANTITY}
												aria-label={`增加 ${line.itemName} 數量`}
												onClick={() => dispatchCart({ type: "increase", lineId: line.id })}
											>
												+
											</button>
											<button
												className="remove-button"
												type="button"
												aria-label={`移除 ${line.itemName}`}
												onClick={() => removeCartLine(line)}
											>
												移除
											</button>
										</div>
									</li>;
								})}
							</ul>
							{removedLine && (
								<div className="cart-undo" role="status">
									<span>已移除「{removedLine.itemName}」</span>
									<button type="button" onClick={undoRemoveCartLine}>復原</button>
								</div>
							)}
							<p className="cart-total">
								<span>總計</span>
								<strong>NT$ {cartTotal}</strong>
							</p>
							<button
								className="checkout-button"
								type="button"
								disabled={!store?.is_accepting_orders}
								onClick={openCheckout}
							>
								{store?.is_accepting_orders ? "去結帳" : "目前暫停接單"}
							</button>
						</>
					)}
					{cart.length === 0 && removedLine && (
						<div className="cart-undo" role="status">
							<span>已移除「{removedLine.itemName}」</span>
							<button type="button" onClick={undoRemoveCartLine}>復原</button>
						</div>
					)}
				</section>
			</main>
		);
	}

	return (
		<main className={`page customer-page${isOnsite ? " onsite-ordering" : ""}${cart.length > 0 ? " has-cart-bar" : ""}`}>
			<CustomerHeader
				displayName={store?.display_name ?? "店家載入中…"}
				isAcceptingOrders={store?.is_accepting_orders ?? null}
				cartItemCount={cartItemCount}
				onCartClick={openCart}
				activeOrderCount={activeOrders.length}
				hasUnreadOrderUpdate={hasUnreadOrderUpdate}
				onOrdersClick={() => setView("orders")}
				orderMode={orderSource}
			/>
			{menu && (
				<CategoryTabs
					categories={menu.categories}
					activeCategoryId={activeCategoryId}
					onCategorySelect={selectCategory}
				/>
			)}

			{store && !store.is_accepting_orders && (
				<p className="store-paused-banner" role="status">
					<strong>目前暫停接單</strong>
					<span>請稍後再試，菜單仍可瀏覽。</span>
				</p>
			)}

			{!menu && !error && (
				<p className="message" role="status">
					菜單載入中…
				</p>
			)}
			{error && (
				<p className="message error" role="alert">
					{error}
				</p>
			)}
			{cartDraftMessage && <p className="cart-draft-message customer-draft-message" role="status">{cartDraftMessage}</p>}
			{addCartFeedback && (
				<p className="add-cart-feedback" role="status" aria-live="polite">
					<span aria-hidden="true">✓</span> {addCartFeedback}
				</p>
			)}

			<div className="customer-menu-content">
			{menu?.categories.map((category) => (
				<section className="category" id={`category-${category.id}`} key={category.id}>
					<h2>{category.name}</h2>
					<ul className="menu-list">
						{[...category.items]
							.sort((left, right) => Number(right.isAvailable) - Number(left.isAvailable))
							.map((item) => {
								return (
									<ProductCard
										key={item.id}
										item={item}
										folds={getProductFolds(item)}
										onAdd={() => addItem(item)}
										isRecentlyAdded={recentlyAddedItemIds.has(item.id)}
									/>
								);
							})}
					</ul>
				</section>
			))}

			{store?.originDisclosure && store.originDisclosure.length > 0 && (
				<aside className="origin-disclosure" aria-label="食材來源資訊">
					<h2>食材來源資訊</h2>
					{store.originDisclosure.map((label) => <p key={label}>{label}</p>)}
				</aside>
			)}
			</div>

			<CartBar itemCount={cartItemCount} total={cartTotal} onClick={openCart} />
		</main>
	);
}

function App() {
	if (window.location.pathname === "/admin" || window.location.pathname === "/admin/menu") {
		return <AdminView />;
	}

	if (window.location.pathname === "/merchant") {
		return <MerchantView />;
	}

	if (window.location.pathname === "/onsite") {
		return <CustomerApp orderSource="onsite" />;
	}

	const orderRoute = window.location.pathname.match(/^\/orders\/([^/]+)$/);

	return orderRoute ? (
		<CustomerOrderStatus publicLookupToken={orderRoute[1]} />
	) : (
		<CustomerApp />
	);
}

export default App;
