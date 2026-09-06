import { useEffect, useReducer, useRef, useState } from "react";
import {
	calculateUnitPrice,
	cartReducer,
	createCartLine,
	getCartItemCount,
	getCartLineSubtotal,
	getCartTotal,
	type SelectedModifier,
} from "./cart";
import { isModifierSelectionComplete } from "./modifier-selection";
import "./App.css";

type StoreSettings = {
	display_name: string;
};

type ModifierOption = {
	id: number;
	name: string;
	priceDelta: number;
};

type ModifierGroup = {
	id: number;
	name: string;
	selectionType: "single";
	isRequired: boolean;
	options: ModifierOption[];
};

type MenuItem = {
	id: number;
	name: string;
	description: string;
	price: number;
	isAvailable: boolean;
	modifierGroups: ModifierGroup[];
};

type MenuCategory = {
	id: number;
	name: string;
	items: MenuItem[];
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

function StoreHeader({ displayName, cartItemCount }: { displayName: string; cartItemCount: number }) {
	return (
		<header className="store-header">
			<div>
				<p className="eyebrow">現點現炸</p>
				<h1>{displayName}</h1>
			</div>
			<p className="cart-count" aria-label={`購物車共 ${cartItemCount} 件`}>
				購物車 {cartItemCount}
			</p>
		</header>
	);
}

function formatReadyTime(estimatedReadyAt: string) {
	return new Intl.DateTimeFormat("zh-TW", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(estimatedReadyAt));
}

function App() {
	const [store, setStore] = useState<StoreSettings | null>(null);
	const [menu, setMenu] = useState<MenuResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
	const [selectedOptionIds, setSelectedOptionIds] = useState<Record<number, number>>({});
	const [cart, dispatchCart] = useReducer(cartReducer, []);
	const [view, setView] = useState<"menu" | "checkout">("menu");
	const [checkoutQuote, setCheckoutQuote] = useState<CheckoutQuote | null>(null);
	const [checkoutError, setCheckoutError] = useState<string | null>(null);
	const [isCheckoutLoading, setIsCheckoutLoading] = useState(false);
	const checkoutRequest = useRef<AbortController | null>(null);

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

	useEffect(() => () => checkoutRequest.current?.abort(), []);

	const selectedModifiers: SelectedModifier[] =
		selectedItem?.modifierGroups.flatMap((group) => {
			const selectedOption = group.options.find(
				(option) => option.id === selectedOptionIds[group.id],
			);

			return selectedOption
				? [
						{
							groupId: group.id,
							groupName: group.name,
							optionId: selectedOption.id,
							optionName: selectedOption.name,
							priceDelta: selectedOption.priceDelta,
						},
					]
				: [];
		}) ?? [];

	const isConfigurationComplete = selectedItem
		? isModifierSelectionComplete(selectedItem.modifierGroups, selectedOptionIds)
		: false;
	const configuredUnitPrice = selectedItem
		? calculateUnitPrice(selectedItem.price, selectedModifiers)
		: 0;
	const cartItemCount = getCartItemCount(cart);
	const cartTotal = getCartTotal(cart);

	function openItem(item: MenuItem) {
		if (!item.isAvailable) {
			return;
		}

		setSelectedItem(item);
		setSelectedOptionIds({});
	}

	function closeItem() {
		setSelectedItem(null);
		setSelectedOptionIds({});
	}

	function addConfiguredItem() {
		if (!selectedItem?.isAvailable || !isConfigurationComplete) {
			return;
		}

		dispatchCart({
			type: "add",
			line: createCartLine(selectedItem, selectedModifiers),
		});
		closeItem();
	}

	async function openCheckout() {
		if (cart.length === 0) {
			return;
		}

		checkoutRequest.current?.abort();
		const controller = new AbortController();
		checkoutRequest.current = controller;
		setView("checkout");
		setCheckoutQuote(null);
		setCheckoutError(null);
		setIsCheckoutLoading(true);

		try {
			const response = await fetch("/api/checkout/quote", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					items: cart.map((line) => ({
						menuItemId: line.menuItemId,
						quantity: line.quantity,
						modifierOptionIds: line.selectedModifiers.map((modifier) => modifier.optionId),
					})),
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
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
		checkoutRequest.current?.abort();
		checkoutRequest.current = null;
		setIsCheckoutLoading(false);
		setView("menu");
	}

	if (view === "checkout") {
		return (
			<main className="page">
				<StoreHeader
					displayName={store?.display_name ?? "店家載入中…"}
					cartItemCount={cartItemCount}
				/>
				<section className="checkout" aria-labelledby="checkout-heading">
					<button className="back-button" type="button" onClick={backToCart}>
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
							<p className="quote-note">價格與取餐時間已由店家系統重新確認。本階段尚不會送出訂單。</p>
						</>
					)}
				</section>
			</main>
		);
	}

	return (
		<main className="page">
			<StoreHeader
				displayName={store?.display_name ?? "店家載入中…"}
				cartItemCount={cartItemCount}
			/>

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

			{menu?.categories.map((category) => (
				<section className="category" key={category.id}>
					<h2>{category.name}</h2>
					<ul className="menu-list">
						{category.items.map((item) => (
							<li className={`menu-item${item.isAvailable ? "" : " sold-out"}`} key={item.id}>
								<button
									className="menu-item-button"
									type="button"
									disabled={!item.isAvailable}
									onClick={() => openItem(item)}
								>
									<span className="item-copy">
										<span className="item-heading">
											<strong>{item.name}</strong>
											{!item.isAvailable && <span className="sold-out-label">售完</span>}
										</span>
										{item.description && <span className="item-description">{item.description}</span>}
									</span>
									<span className="price">NT$ {item.price}</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			))}

			<section className="cart" aria-labelledby="cart-heading">
				<div className="section-heading">
					<h2 id="cart-heading">購物車</h2>
					<span>{cartItemCount} 件</span>
				</div>
				{cart.length === 0 ? (
					<p className="empty-cart">尚未加入餐點</p>
				) : (
					<>
						<ul className="cart-lines">
							{cart.map((line) => (
								<li key={line.id}>
									<div className="cart-line-heading">
										<strong>
											{line.itemName} × {line.quantity}
										</strong>
										<span>NT$ {getCartLineSubtotal(line)}</span>
									</div>
									{line.selectedModifiers.length > 0 && (
										<p>{line.selectedModifiers.map((modifier) => modifier.optionName).join(" / ")}</p>
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
								</li>
							))}
						</ul>
						<p className="cart-total">
							<span>總計</span>
							<strong>NT$ {cartTotal}</strong>
						</p>
						<button className="checkout-button" type="button" onClick={openCheckout}>
							查看結帳報價
						</button>
					</>
				)}
			</section>

			{selectedItem && (
				<div className="dialog-backdrop">
					<section
						className="item-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="item-dialog-title"
					>
						<div className="dialog-heading">
							<div>
								<h2 id="item-dialog-title">{selectedItem.name}</h2>
								<p>NT$ {configuredUnitPrice}</p>
							</div>
							<button type="button" aria-label="關閉餐點設定" onClick={closeItem}>
								×
							</button>
						</div>

						{selectedItem.modifierGroups.map((group) => (
							<fieldset key={group.id}>
								<legend>
									{group.name}
									{group.isRequired && <span>必選</span>}
								</legend>
								{group.options.map((option) => (
									<label key={option.id}>
										<input
											type="radio"
											name={`modifier-${selectedItem.id}-${group.id}`}
											value={option.id}
											checked={selectedOptionIds[group.id] === option.id}
											onChange={() =>
												setSelectedOptionIds((current) => ({
													...current,
													[group.id]: option.id,
												}))
											}
										/>
										<span>{option.name}</span>
										{option.priceDelta !== 0 && <small>+ NT$ {option.priceDelta}</small>}
									</label>
								))}
							</fieldset>
						))}

						<button
							className="add-to-cart-button"
							type="button"
							disabled={!isConfigurationComplete}
							onClick={addConfiguredItem}
						>
							加入購物車 · NT$ {configuredUnitPrice}
						</button>
					</section>
				</div>
			)}
		</main>
	);
}

export default App;
