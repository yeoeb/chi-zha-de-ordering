import { useEffect, useReducer, useRef, useState, type FormEvent } from "react";
import {
	cartReducer,
	createCartLine,
	getCartItemCount,
	getCartLineSubtotal,
	getCartTotal,
	type CartLine,
} from "./cart";
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
	toSelectedModifier,
	type MenuItem,
	type MenuCategory,
	type SpiceChoice,
} from "./customer-menu";
import CustomerOrderStatus from "./CustomerOrderStatus";
import AdminView from "./AdminView";
import MerchantView from "./MerchantView";
import type { CustomerOrder } from "./order-status";

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
};

const CUSTOMER_NOTE_MAX_CHARACTERS = 120;
const PEPPER_PACKET_NOTE = "辣粉另包";

function hasControlCharacter(value: string) {
	return [...value].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
	});
}

function composeCustomerNote(note: string, pepperPacketRequested: boolean) {
	const normalized = note.trim();
	if (!pepperPacketRequested) return normalized || null;
	return normalized ? `${normalized}；${PEPPER_PACKET_NOTE}` : PEPPER_PACKET_NOTE;
}

function validateCustomerNote(note: string | null) {
	if (note === null) return null;
	if (hasControlCharacter(note)) return "備註不可包含換行或控制字元。";
	if ([...note].length > CUSTOMER_NOTE_MAX_CHARACTERS) {
		return `備註與辣粉另包標示合計不可超過 ${CUSTOMER_NOTE_MAX_CHARACTERS} 個字。`;
	}
	return null;
}

function formatReadyTime(estimatedReadyAt: string) {
	return new Intl.DateTimeFormat("zh-TW", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(estimatedReadyAt));
}

export function CustomerApp() {
	const [store, setStore] = useState<StoreSettings | null>(null);
	const [menu, setMenu] = useState<MenuResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [productOptionIds, setProductOptionIds] = useState<
		Record<number, Record<number, number | null>>
	>({});
	const [cart, dispatchCart] = useReducer(cartReducer, []);
	const [view, setView] = useState<"menu" | "cart" | "checkout">("menu");
	const [activeCategoryId, setActiveCategoryId] = useState<number | null>(null);
	const [checkoutQuote, setCheckoutQuote] = useState<CheckoutQuote | null>(null);
	const [checkoutError, setCheckoutError] = useState<string | null>(null);
	const [isCheckoutLoading, setIsCheckoutLoading] = useState(false);
	const [customerName, setCustomerName] = useState("");
	const [customerPhone, setCustomerPhone] = useState("");
	const [specialOrder, setSpecialOrder] = useState(false);
	const [orderNote, setOrderNote] = useState("");
	const [pepperPacketRequested, setPepperPacketRequested] = useState(false);
	const [isOrderSubmitting, setIsOrderSubmitting] = useState(false);
	const [orderError, setOrderError] = useState<string | null>(null);
	const [createdOrder, setCreatedOrder] = useState<CustomerOrder | null>(null);
	const checkoutRequest = useRef<AbortController | null>(null);
	const orderIdempotencyKey = useRef<string | null>(null);
	const categorySelectionTarget = useRef<number | null>(null);
	const categorySelectionTimer = useRef<number | null>(null);

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

	useEffect(() => () => {
		checkoutRequest.current?.abort();
		if (categorySelectionTimer.current !== null) {
			window.clearTimeout(categorySelectionTimer.current);
		}
	}, []);

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

		function updateActiveCategory() {
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

			if (categorySelectionTarget.current !== null) {
				const targetSection = sections.find(
					(section) => section.categoryId === categorySelectionTarget.current,
				);
				if (targetSection && targetSection.rect.top > stickyOffset) {
					return;
				}
				categorySelectionTarget.current = null;
			}

			let nextActiveId = sections[0]?.categoryId ?? null;
			for (const section of sections) {
				if (section.rect.top <= stickyOffset) nextActiveId = section.categoryId;
				else break;
			}
			setActiveCategoryId((current) => current === nextActiveId ? current : nextActiveId);
		}

		updateActiveCategory();
		window.addEventListener("scroll", updateActiveCategory, { passive: true });
		window.addEventListener("resize", updateActiveCategory);
		return () => {
			window.removeEventListener("scroll", updateActiveCategory);
			window.removeEventListener("resize", updateActiveCategory);
		};
	}, [menu, view]);

	const cartItemCount = getCartItemCount(cart);
	const cartTotal = getCartTotal(cart);
	const checkoutItems = cart.map((line) => ({
		menuItemId: line.menuItemId,
		quantity: line.quantity,
		modifierOptionIds: line.selectedModifiers.map((modifier) => modifier.optionId),
	}));
	const submittedCustomerNote = composeCustomerNote(orderNote, pepperPacketRequested);
	const customerNoteError = hasControlCharacter(orderNote)
		? "備註不可包含換行或控制字元。"
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
		dispatchCart({
			type: "add",
			line: createCartLine(item, modifiersFromOptionIds(item, getItemOptionIds(item))),
		});
	}

	function applyBulkSpice(nextChoice: SpiceChoice) {
		const menuItems = menu?.categories.flatMap((category) => category.items) ?? [];

		cart.forEach((line) => {
			const item = menuItems.find((candidate) => candidate.id === line.menuItemId);
			const group = item ? getSpiceGroup(item) : undefined;
			if (!group) return;

			const targetOption = group.options.find((option) => option.name === nextChoice);
			if (!targetOption) return;

			const replacement = toSelectedModifier(group, targetOption);
			const selectedModifiers = [
				...line.selectedModifiers.filter((modifier) => modifier.groupId !== group.id),
				replacement,
			];
			dispatchCart({
				type: "reconfigure",
				lineId: line.id,
				selectedModifiers,
			});
		});
	}

	function updateLineSpice(line: CartLine, item: MenuItem, optionId: number) {
		const group = getSpiceGroup(item);
		const option = group?.options.find((candidate) => candidate.id === optionId);
		if (!group || !option) return;
		dispatchCart({
			type: "reconfigure",
			lineId: line.id,
			selectedModifiers: [
				...line.selectedModifiers.filter((modifier) => modifier.groupId !== group.id),
				toSelectedModifier(group, option),
			],
		});
	}

	function openCart() {
		setView("cart");
	}

	function continueShopping() {
		setView("menu");
	}

	function scrollCartToTop() {
		document.documentElement.scrollTop = 0;
		document.body.scrollTop = 0;
	}

	function selectCategory(categoryId: number) {
		categorySelectionTarget.current = categoryId;
		if (categorySelectionTimer.current !== null) {
			window.clearTimeout(categorySelectionTimer.current);
		}
		categorySelectionTimer.current = window.setTimeout(() => {
			categorySelectionTarget.current = null;
			window.dispatchEvent(new Event("scroll"));
		}, 1200);
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

	async function openCheckout() {
		if (cart.length === 0 || !store?.is_accepting_orders) {
			return;
		}

		checkoutRequest.current?.abort();
		const controller = new AbortController();
		checkoutRequest.current = controller;
		setView("checkout");
		setCheckoutQuote(null);
		setCheckoutError(null);
		setOrderError(null);
		setCreatedOrder(null);
		orderIdempotencyKey.current = null;
		setIsCheckoutLoading(true);

		try {
			const response = await fetch("/api/checkout/quote", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					items: checkoutItems,
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				const rejection = (await response.json()) as {
					error?: { code?: string };
				};

				if (rejection.error?.code === "STORE_NOT_ACCEPTING_ORDERS") {
					setStore((current) =>
						current ? { ...current, is_accepting_orders: false } : current,
					);
					setCheckoutError("目前暫停接單，請稍後再試。");
					return;
				}

				throw new Error("Checkout quote was rejected");
			}

			setCheckoutQuote((await response.json()) as CheckoutQuote);
		} catch (quoteError: unknown) {
			if (!(quoteError instanceof Error && quoteError.name === "AbortError")) {
				setCheckoutError(
					"目前無法取得結帳報價。餐點可能已售完或選項已變更，請返回購物車確認後再試。",
				);
			}
		} finally {
			if (!controller.signal.aborted) {
				setIsCheckoutLoading(false);
			}
		}
	}

	function backToCart() {
		if (isOrderSubmitting) {
			return;
		}

		checkoutRequest.current?.abort();
		checkoutRequest.current = null;
		orderIdempotencyKey.current = null;
		setIsCheckoutLoading(false);
		setView("cart");
	}

	function resetSubmissionAttempt() {
		orderIdempotencyKey.current = null;
		setOrderError(null);
	}

	async function submitOrder(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();

		if (
			!checkoutQuote ||
			isOrderSubmitting ||
			!customerName.trim() ||
			!customerPhone.trim() ||
			customerNoteError
		) {
			return;
		}

		const idempotencyKey = orderIdempotencyKey.current ?? crypto.randomUUID();
		orderIdempotencyKey.current = idempotencyKey;
		setIsOrderSubmitting(true);
		setOrderError(null);

		try {
			const response = await fetch("/api/orders", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": idempotencyKey,
				},
				body: JSON.stringify({
					customerName,
					customerPhone,
					specialOrder,
					customerNote: submittedCustomerNote,
					items: checkoutItems,
				}),
			});

			if (!response.ok) {
				throw new Error("Order creation was rejected");
			}

			const result = (await response.json()) as { order: CustomerOrder };
			setCreatedOrder(result.order);
			window.history.replaceState(
				null,
				"",
				`/orders/${encodeURIComponent(result.order.publicLookupToken)}`,
			);
		} catch {
			setOrderError(
				"訂單尚未成功送出。餐點可能已變更，請確認資料後重試；重試不會重複建立訂單。",
			);
		} finally {
			setIsOrderSubmitting(false);
		}
	}

	if (createdOrder) {
		return (
			<CustomerOrderStatus
				publicLookupToken={createdOrder.publicLookupToken}
				initialOrder={createdOrder}
			/>
		);
	}

	if (view === "checkout") {
		return (
			<main className="page customer-page customer-checkout-page">
				<CustomerHeader
					displayName={store?.display_name ?? "店家載入中…"}
					isAcceptingOrders={store?.is_accepting_orders ?? null}
					cartItemCount={cartItemCount}
					onCartClick={backToCart}
				/>
				<section className="checkout" aria-labelledby="checkout-heading">
					<button
						className="back-button"
						type="button"
						disabled={isOrderSubmitting}
						onClick={backToCart}
					>
						← 返回購物車
					</button>
					<p className="eyebrow checkout-eyebrow">確認餐點</p>
					<h2 id="checkout-heading">結帳報價</h2>

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

							<div className="ready-time">
								<span>預計可取餐</span>
								<strong>{formatReadyTime(checkoutQuote.estimatedReadyAt)}</strong>
								<small>約 {checkoutQuote.leadMinutes} 分鐘</small>
							</div>

							<p className="quote-total">
								<span>結帳總計</span>
								<strong>NT$ {checkoutQuote.total}</strong>
							</p>
							<p className="quote-note">價格與取餐時間已由店家系統重新確認；送出時系統會再次驗證。</p>

							<form className="customer-form" onSubmit={submitOrder}>
								<label>
									<span>姓名</span>
									<input
										type="text"
										maxLength={50}
										required
										disabled={isOrderSubmitting}
										value={customerName}
										onChange={(event) => {
											setCustomerName(event.target.value);
											resetSubmissionAttempt();
										}}
									/>
								</label>
								<label>
									<span>電話</span>
									<input
										type="tel"
										inputMode="tel"
										pattern="[0-9+()\-\s]{7,30}"
										title="請輸入 7 至 30 字元的電話格式"
										maxLength={30}
										required
										disabled={isOrderSubmitting}
										value={customerPhone}
										onChange={(event) => {
											setCustomerPhone(event.target.value);
											resetSubmissionAttempt();
										}}
									/>
								</label>
								<label className="pepper-packet-field">
									<input
										type="checkbox"
										disabled={isOrderSubmitting}
										checked={pepperPacketRequested}
										onChange={(event) => {
											setPepperPacketRequested(event.target.checked);
											resetSubmissionAttempt();
										}}
									/>
									<span>辣粉另包</span>
								</label>
								<label className="order-note-field">
									<span>訂單備註（選填）</span>
									<textarea
										disabled={isOrderSubmitting}
										placeholder="例如：辣／不辣分開裝、其他特殊需求"
										value={orderNote}
										onChange={(event) => {
											setOrderNote(event.target.value);
											resetSubmissionAttempt();
										}}
									/>
									<small>如需分袋，可備註「辣／不辣分開裝」；未特別註明則一起裝。</small>
									<small>需加價的需求請使用餐點選項，請勿填在備註。</small>
									<small>{customerNoteCharacterCount} / {CUSTOMER_NOTE_MAX_CHARACTERS} 字</small>
									{customerNoteError && <small className="note-error" role="alert">{customerNoteError}</small>}
								</label>
								<label className="special-order-field">
									<input
										type="checkbox"
										disabled={isOrderSubmitting}
										checked={specialOrder}
										onChange={(event) => {
											setSpecialOrder(event.target.checked);
											resetSubmissionAttempt();
										}}
									/>
									<span>特殊訂單（需要較多準備時間）</span>
								</label>

								{orderError && (
									<p className="message error" role="alert">
										{orderError}
									</p>
								)}

								<button
									className="submit-order-button"
									type="submit"
									disabled={
										isOrderSubmitting ||
										!customerName.trim() ||
										!customerPhone.trim() ||
										Boolean(customerNoteError)
									}
								>
									{isOrderSubmitting ? "送出中…" : "送出訂單"}
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
				/>
				<section className="cart customer-cart-view" aria-labelledby="cart-heading">
					<button className="back-button" type="button" onClick={continueShopping}>
						← 繼續點餐
					</button>
					<div className="section-heading">
						<h2 id="cart-heading">購物車</h2>
						<span>{cartItemCount} 件</span>
					</div>
					{cart.some((line) => {
						const item = menu?.categories
							.flatMap((category) => category.items)
							.find((candidate) => candidate.id === line.menuItemId);
						return item ? Boolean(getSpiceGroup(item)) : false;
					}) && <BulkSpiceSelector onApply={applyBulkSpice} />}
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
												aria-label={`增加 ${line.itemName} 數量`}
												onClick={() => dispatchCart({ type: "increase", lineId: line.id })}
											>
												+
											</button>
											<button
												className="remove-button"
												type="button"
												onClick={() => dispatchCart({ type: "remove", lineId: line.id })}
											>
												移除
											</button>
										</div>
									</li>;
								})}
							</ul>
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
								{store?.is_accepting_orders ? "下一步：確認訂單" : "目前暫停接單"}
							</button>
						</>
					)}
				</section>
			</main>
		);
	}

	return (
		<main className={`page customer-page${cart.length > 0 ? " has-cart-bar" : ""}`}>
			<CustomerHeader
				displayName={store?.display_name ?? "店家載入中…"}
				isAcceptingOrders={store?.is_accepting_orders ?? null}
				cartItemCount={cartItemCount}
				onCartClick={openCart}
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

	const orderRoute = window.location.pathname.match(/^\/orders\/([^/]+)$/);

	return orderRoute ? (
		<CustomerOrderStatus publicLookupToken={orderRoute[1]} />
	) : (
		<CustomerApp />
	);
}

export default App;
