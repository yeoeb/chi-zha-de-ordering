import { useEffect, useId, useRef, useState } from "react";
import type { MenuCategory, MenuItem, SpiceChoice } from "./customer-menu";
import { isPopularItem, spiceChoices } from "./customer-menu";

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
		<div className="product-image-placeholder" aria-label={`${item.name} 暫無圖片`}>
			<span>吃炸的</span>
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
				<p className="customer-kicker">{orderMode === "onsite" ? "現場點餐" : "現點現炸"}</p>
				<h1>{displayName}</h1>
				<p className={`store-state ${isAcceptingOrders === null ? "unknown" : isAcceptingOrders ? "accepting" : "paused"}`}>
					<span aria-hidden="true" />
					{isAcceptingOrders === null
						? "無法確認營業狀態"
						: isAcceptingOrders
							? "營業中・可接單"
							: "暫停接單"}
				</p>
			</div>
			<div className="customer-header-actions">
				{onOrdersClick && (
					<button
						className="header-orders-button"
						type="button"
						onClick={onOrdersClick}
						aria-label={`我的訂單${activeOrderCount > 1 ? ` ${activeOrderCount}` : ""}${hasUnreadOrderUpdate ? "，有未讀變更" : ""}`}
					>
						<ReceiptIcon />
						<span>我的訂單{activeOrderCount > 1 ? ` ${activeOrderCount}` : ""}</span>
						{hasUnreadOrderUpdate && <span className="order-update-badge" aria-hidden="true">!</span>}
					</button>
				)}
				<button className="header-cart-button" type="button" onClick={onCartClick} aria-label={`購物車共 ${cartItemCount} 件`}>
					<ShoppingCartIcon />
					{cartItemCount > 0 && <span className="cart-badge">{cartItemCount}</span>}
				</button>
			</div>
		</header>
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
		<nav ref={navRef} className="category-tabs" aria-label="餐點分類">
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
				className="inline-option-toggle"
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
						<label key={choice.id}>
							<input
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
	isRecentlyAdded = false,
}: {
	item: MenuItem;
	folds: ProductFoldDefinition[];
	onAdd: () => void;
	isRecentlyAdded?: boolean;
}) {
	return (
		<li className={`product-card${item.isAvailable ? "" : " sold-out"}`}>
			<div className="product-card-main">
				<div className="product-image-wrap">
					<ProductImage key={`${item.id}:${item.imageUrl ?? "fallback"}`} item={item} />
					{isPopularItem(item) && item.isAvailable && <span className="popular-badge">熱門推薦</span>}
				</div>
				<div className="product-copy">
					<div className="product-title-row">
						<h3>{item.name}</h3>
						{!item.isAvailable && <span className="sold-out-label">已售完</span>}
					</div>
					{item.description && <p>{item.description}</p>}
					<div className="product-action-row">
						<strong className="price">NT$ {item.price}</strong>
						<button
							className={isRecentlyAdded ? "product-add-button is-added" : "product-add-button"}
							type="button"
							disabled={!item.isAvailable}
							onClick={onAdd}
							aria-label={`加入 ${item.name}`}
						>
							{item.isAvailable ? (isRecentlyAdded ? "✓" : "+") : "已售完"}
						</button>
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
			<legend>快速套用辣度</legend>
			<p>只套用到目前購物車內可選辣度的餐點</p>
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
							className={feedback?.choice === choice ? `bulk-action-feedback ${feedback.tone}` : undefined}
							type="button"
							disabled={availability === "none"}
							aria-pressed={activeChoice === choice}
							title={availability === "partial" ? "部分商品沒有該選項" : undefined}
							onClick={() => onApply(choice)}
						>
							{choice}{availability === "partial" ? "（部分）" : ""}
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
			<button className="cart-bar" type="button" onClick={onClick}>
				<span className="cart-bar-count">{itemCount}</span>
				<span>NT$ {total}</span>
				<strong>查看購物車 <span aria-hidden="true">→</span></strong>
			</button>
		</div>
	);
}
