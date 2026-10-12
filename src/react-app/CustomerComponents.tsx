import { uiCopy } from "./ui-copy";
import { useEffect, useId, useRef, useState } from "react";
import type { MenuCategory, MenuItem, SpiceChoice } from "./customer-menu";
import { isPopularItem, spiceChoices } from "./customer-menu";
import { spiceSemanticClass } from "./spice-presentation";

export type InlineFoldChoice = {
	id: string;
	label: string;
	selected: boolean;
};

export type ProductFoldDefinition = {
	id: string;
	label: string;
	summary: string;
	mode: "single" | "multiple";
	choices: InlineFoldChoice[];
	onChange: (choiceId: string, selected: boolean) => void;
};

function ProductImage({ item }: { item: MenuItem }) {
	const [hasError, setHasError] = useState(false);

	return item.imageUrl && !hasError ? (
		<img
			src={item.imageUrl}
			alt=""
			className="product-image"
			loading="lazy"
			onError={() => setHasError(true)}
		/>
	) : (
		<div className="product-image-placeholder" aria-label={`${item.name}${uiCopy.customer.imageMissingSuffix}`}>
			<span>{uiCopy.common.brand}</span>
		</div>
	);
}

function ShoppingCartIcon() {
	return (
		<svg className="header-action-icon" viewBox="0 0 24 24" aria-hidden="true">
			<path d="M3 4h2l2.1 10.1a2 2 0 0 0 2 1.6h7.8a2 2 0 0 0 1.9-1.4L21 7H6" />
			<circle cx="9" cy="19" r="1.5" />
			<circle cx="18" cy="19" r="1.5" />
		</svg>
	);
}

function ReceiptIcon() {
	return (
		<svg className="header-action-icon" viewBox="0 0 24 24" aria-hidden="true">
			<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" />
			<path d="M9 8h6M9 12h6M9 16h3" />
		</svg>
	);
}

export function CustomerHeader({
	displayName,
	isAcceptingOrders,
	cartItemCount,
	onCartClick,
	activeOrderCount = 0,
	hasUnreadOrderUpdate = false,
	onOrdersClick,
	orderMode = "online",
}: {
	displayName: string;
	isAcceptingOrders: boolean | null;
	cartItemCount: number;
	onCartClick: () => void;
	activeOrderCount?: number;
	hasUnreadOrderUpdate?: boolean;
	onOrdersClick?: () => void;
	orderMode?: "online" | "onsite";
}) {
	return (
		<header className="customer-header">
			<div>
				<p className="customer-kicker">{orderMode === "onsite" ? uiCopy.onsite.title : uiCopy.customer.kicker}</p>
				<h1>{displayName}</h1>
				<p className={`store-state ${isAcceptingOrders === null ? "unknown" : isAcceptingOrders ? "accepting" : "paused"}`}>
					<span aria-hidden="true" />
					{isAcceptingOrders === null
						? uiCopy.customer.storeUnknown
						: isAcceptingOrders
							? uiCopy.customer.storeAccepting
							: uiCopy.customer.storePaused}
				</p>
			</div>
			<div className="customer-header-actions">
				{onOrdersClick && (
					<button
						className="header-orders-button"
						type="button"
						onClick={onOrdersClick}
						aria-label={`${uiCopy.customer.myOrders}${activeOrderCount > 1 ? ` ${activeOrderCount}` : ""}${hasUnreadOrderUpdate ? uiCopy.customer.unreadUpdate : ""}`}
					>
						<ReceiptIcon />
						<span>{uiCopy.customer.myOrders}{activeOrderCount > 1 ? ` ${activeOrderCount}` : ""}</span>
						{hasUnreadOrderUpdate && <span className="order-update-badge" aria-hidden="true">!</span>}
					</button>
				)}
				<button className="header-cart-button" type="button" onClick={onCartClick} aria-label={`${uiCopy.customer.cartCountPrefix}${cartItemCount}${uiCopy.customer.cartCountSuffix}`}>
					<ShoppingCartIcon />
					{cartItemCount > 0 && <span className="cart-badge">{cartItemCount}</span>}
				</button>
			</div>
		</header>
	);
}

export function BusinessHoursPill({
	todayIsOpen,
	todayOpenAt,
	todayCloseAt,
	lastOrderAt,
}: {
	todayIsOpen: boolean | null;
	todayOpenAt: string | null;
	todayCloseAt: string | null;
	lastOrderAt: string | null;
}) {
	const [open, setOpen] = useState(false);
	if (todayIsOpen === null) return null;
	const softClosing = todayIsOpen && todayOpenAt === "17:30" && todayCloseAt === "23:15" && (lastOrderAt === null || lastOrderAt === "23:15");
	const summary = todayIsOpen && todayOpenAt && todayCloseAt
		? `${uiCopy.customer.todayHoursPrefix}${todayOpenAt}–${todayCloseAt}`
		: uiCopy.customer.closedToday;
	return (
		<div className="business-hours-floating">
			<button type="button" aria-expanded={open} aria-controls="business-hours-panel" onClick={() => setOpen((current) => !current)}>
				<span aria-hidden="true">🕒</span> {summary}
			</button>
			{open && <>
				<button className="business-hours-dismiss" type="button" aria-label={uiCopy.customer.closeHours} onClick={() => setOpen(false)} />
				<section id="business-hours-panel" className="business-hours-panel" aria-label={uiCopy.customer.todayHours}>
					<header><strong>{uiCopy.customer.todayHours}</strong><button type="button" aria-label={uiCopy.common.close} onClick={() => setOpen(false)}>×</button></header>
					<p>{todayIsOpen && todayOpenAt && todayCloseAt ? `${todayOpenAt} – ${todayCloseAt}` : uiCopy.customer.closedToday}</p>
					{todayIsOpen && (lastOrderAt || softClosing) && <p><span>{softClosing ? "最早收店" : uiCopy.customer.lastOrder}</span><strong>{lastOrderAt ?? todayCloseAt}</strong></p>}
					{softClosing && <p>23:15 後依訂單狀況延後收店，請依目前接單狀態下單。</p>}
				</section>
			</>}
		</div>
	);
}

export function CategoryTabs({
	categories,
	activeCategoryId,
	onCategorySelect,
}: {
	categories: MenuCategory[];
	activeCategoryId: number | null;
	onCategorySelect: (categoryId: number) => void;
}) {
	const tabRefs = useRef(new Map<number, HTMLAnchorElement>());
	const navRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (activeCategoryId === null) return;
		const activeTab = tabRefs.current.get(activeCategoryId);
		const navigation = navRef.current;
		if (!activeTab || !navigation) return;
		const tabLeft = activeTab.offsetLeft;
		const tabRight = tabLeft + activeTab.offsetWidth;
		const visibleLeft = navigation.scrollLeft;
		const visibleRight = visibleLeft + navigation.clientWidth;
		if (tabLeft >= visibleLeft && tabRight <= visibleRight) return;
		const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
		const left = tabLeft < visibleLeft ? tabLeft : tabRight - navigation.clientWidth;
		if (typeof navigation.scrollTo === "function") {
			navigation.scrollTo({ left, behavior: reduceMotion ? "auto" : "smooth" });
		} else {
			navigation.scrollLeft = left;
		}
	}, [activeCategoryId]);

	return (
		<nav ref={navRef} className="category-tabs" aria-label={uiCopy.customer.categories}>
			{categories.map((category) => (
				<a
					key={category.id}
					href={`#category-${category.id}`}
					ref={(element) => {
						if (element) tabRefs.current.set(category.id, element);
						else tabRefs.current.delete(category.id);
					}}
					aria-current={activeCategoryId === category.id ? "true" : undefined}
					onClick={(event) => {
						event.preventDefault();
						onCategorySelect(category.id);
					}}
				>
					{category.name}
				</a>
			))}
		</nav>
	);
}

export function InlineFoldOptionGroup({
	label,
	summary,
	mode,
	choices,
	onChange,
	disabled = false,
}: {
	label: string;
	summary: string;
	mode: "single" | "multiple";
	choices: InlineFoldChoice[];
	onChange: (choiceId: string, selected: boolean) => void;
	disabled?: boolean;
}) {
	const [isExpanded, setIsExpanded] = useState(false);
	const generatedId = useId();
	const panelId = `inline-options-${generatedId.replace(/:/g, "")}`;

	return (
		<div className="inline-option-group">
			<button
				className={`inline-option-toggle${label === "辣度" ? ` ${spiceSemanticClass(choices.find((choice) => choice.selected)?.label ?? "")}` : ""}`}
				type="button"
				disabled={disabled}
				aria-expanded={isExpanded}
				aria-controls={panelId}
				onClick={() => setIsExpanded((current) => !current)}
			>
				<span>{summary}</span>
				<span className="fold-chevron" aria-hidden="true">{isExpanded ? "⌃" : "⌄"}</span>
			</button>
			{isExpanded && (
				<fieldset id={panelId} className="inline-option-panel">
					<legend className="visually-hidden">{label}</legend>
					{choices.map((choice) => (
						<label className={label === "辣度" ? spiceSemanticClass(choice.label) : undefined} key={choice.id} htmlFor={`${panelId}-${choice.id}`}>
							<input
								id={`${panelId}-${choice.id}`}
								type={mode === "single" ? "radio" : "checkbox"}
								name={`${panelId}-choice`}
								checked={choice.selected}
								onChange={(event) => onChange(choice.id, event.target.checked)}
							/>
							<span>{choice.label}</span>
						</label>
					))}
				</fieldset>
			)}
		</div>
	);
}

export function ProductCard({
	item,
	folds,
	onAdd,
	onDecrease,
	quantity = 0,
	isRecentlyAdded = false,
	displayPrice = item.price,
	showImage = true,
}: {
	item: MenuItem;
	folds: ProductFoldDefinition[];
	onAdd: () => void;
	onDecrease: () => void;
	quantity?: number;
	isRecentlyAdded?: boolean;
	displayPrice?: number;
	showImage?: boolean;
}) {
	const [quantityExpanded, setQuantityExpanded] = useState(quantity > 0);
	const previousQuantity = useRef(quantity);
	const collapseTimer = useRef<number | null>(null);

	function scheduleQuantityCollapse() {
		if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
		collapseTimer.current = window.setTimeout(() => {
			setQuantityExpanded(false);
			collapseTimer.current = null;
		}, 2_000);
	}

	useEffect(() => {
		if (quantity <= 0) {
			setQuantityExpanded(false);
			if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
			collapseTimer.current = null;
		} else if (quantity !== previousQuantity.current) {
			setQuantityExpanded(true);
			scheduleQuantityCollapse();
		}
		previousQuantity.current = quantity;
	}, [quantity]);

	useEffect(() => () => {
		if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
	}, []);

	return (
		<li className={`product-card${showImage ? "" : " without-image"}${item.isAvailable ? "" : " sold-out"}`}>
			<div className="product-card-main">
				{showImage && <div className="product-image-wrap">
					<ProductImage key={`${item.id}:${item.imageUrl ?? "fallback"}`} item={item} />
					{isPopularItem(item) && item.isAvailable && <span className="popular-badge">{uiCopy.customer.popular}</span>}
				</div>}
				<div className="product-copy">
					<div className="product-title-row">
						<h3>{item.name}</h3>
						{!showImage && isPopularItem(item) && item.isAvailable && <span className="popular-badge inline">{uiCopy.customer.popular}</span>}
						{!item.isAvailable && <span className="sold-out-label">{uiCopy.customer.soldOut}</span>}
					</div>
					{item.description && <p>{item.description}</p>}
					<div className="product-action-row">
						<strong className="price">NT$ {displayPrice}</strong>
						{item.isAvailable && quantity > 0 && quantityExpanded ? (
							<div className="product-quantity-control" aria-label={`${item.name}${uiCopy.customer.quantitySeparator}${quantity}`}>
								<button type="button" onClick={() => { onDecrease(); scheduleQuantityCollapse(); }} aria-label={`${uiCopy.customer.decreasePrefix}${item.name}${uiCopy.customer.quantitySuffix}`}>−</button>
								<span className={isRecentlyAdded ? "quantity-value is-added" : "quantity-value"}>{quantity}</span>
								<button
									type="button"
									className={isRecentlyAdded ? "is-added" : undefined}
									onClick={() => { onAdd(); scheduleQuantityCollapse(); }}
									aria-label={`${uiCopy.customer.increasePrefix}${item.name}${uiCopy.customer.quantitySuffix}`}
								>
									+
								</button>
							</div>
						) : item.isAvailable && quantity > 0 ? (
							<button
								className="product-quantity-collapsed"
								type="button"
								onClick={() => { setQuantityExpanded(true); scheduleQuantityCollapse(); }}
								aria-label={`${item.name}${uiCopy.customer.addedQuantityPrefix}${quantity}${uiCopy.customer.expandQuantitySuffix}`}
							>
								×{quantity}
							</button>
						) : (
							<button
								className="product-add-button"
								type="button"
								disabled={!item.isAvailable}
								onClick={onAdd}
								aria-label={`${uiCopy.customer.addPrefix}${item.name}`}
							>
								{item.isAvailable ? "+" : uiCopy.customer.soldOut}
							</button>
						)}
					</div>
				</div>
			</div>
			{folds.map((fold) => (
				<InlineFoldOptionGroup
					key={fold.id}
					label={fold.label}
					summary={fold.summary}
					mode={fold.mode}
					choices={fold.choices}
					onChange={fold.onChange}
					disabled={!item.isAvailable}
				/>
			))}
		</li>
	);
}

export function BulkSpiceSelector({
	currentSummary,
	feedback,
	activeChoice,
	choiceAvailability,
	onApply,
}: {
	currentSummary: string;
	feedback: { choice: SpiceChoice; message: string; tone: "success" | "error" } | null;
	activeChoice: SpiceChoice | null;
	choiceAvailability: Record<SpiceChoice, "all" | "partial" | "none">;
	onApply: (value: SpiceChoice) => void;
}) {
	return (
		<fieldset className="spice-selector">
			<legend>{uiCopy.customer.bulkSpice}</legend>
			<p>{uiCopy.customer.bulkSpiceHint}</p>
			<p
				className={`spice-selector-state${feedback ? ` ${feedback.tone}` : ""}`}
				role={feedback?.tone === "error" ? "alert" : "status"}
			>
				{feedback?.message ?? currentSummary}
			</p>
			<div>
				{spiceChoices.map((choice) => {
					const availability = choiceAvailability[choice];
					return (
						<button
							key={choice}
							className={`${spiceSemanticClass(choice)}${feedback?.choice === choice ? ` bulk-action-feedback ${feedback.tone}` : ""}`}
							type="button"
							disabled={availability === "none"}
							aria-pressed={activeChoice === choice}
							title={availability === "partial" ? uiCopy.customer.partialSpiceSupport : undefined}
							onClick={() => onApply(choice)}
						>
							{choice}{availability === "partial" ? uiCopy.customer.partialChoice : ""}
						</button>
					);
				})}
			</div>
		</fieldset>
	);
}

export function CartBar({ itemCount, total, onClick }: { itemCount: number; total: number; onClick: () => void }) {
	if (itemCount === 0) return null;
	return (
		<div className="cart-bar-wrap">
			<button className="cart-bar" type="button" aria-label={`${uiCopy.customer.cartBarPrefix}${itemCount}${uiCopy.customer.cartBarPriceSeparator}${total}${uiCopy.customer.cartBarLabelSuffix}`} onClick={onClick}>
				<strong className="cart-bar-summary">{uiCopy.customer.cart} · {itemCount} {uiCopy.customer.cartBarVisiblePriceSeparator}{total}</strong>
				<span className="cart-bar-action">{uiCopy.customer.view} <span aria-hidden="true">→</span></span>
			</button>
		</div>
	);
}
