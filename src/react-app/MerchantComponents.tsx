import {
	getDeadlineState,
	type MerchantMenuCategory,
	type MerchantMenuItem,
	type MerchantModifier,
	type MerchantOrder,
	type MerchantViewName,
} from "./merchant-operations";

const LARGE_ORDER_QUANTITY = 8;

function formatReadyTime(timestamp: string) {
	return new Intl.DateTimeFormat("zh-TW", {
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(timestamp));
}

function modifierLabel(modifier: MerchantModifier) {
	if (modifier.groupName.startsWith("特殊選項：")) return modifier.name;
	return `${modifier.groupName}：${modifier.name}`;
}

export function MerchantPrimaryNavigation({
	activeView,
	onChange,
}: {
	activeView: MerchantViewName;
	onChange: (view: MerchantViewName) => void;
}) {
	return (
		<nav className="merchant-primary-nav" aria-label="店家主要功能">
			<button
				type="button"
				aria-current={activeView === "orders" ? "page" : undefined}
				onClick={() => onChange("orders")}
			>
				接單
			</button>
			<button
				type="button"
				aria-current={activeView === "availability" ? "page" : undefined}
				onClick={() => onChange("availability")}
			>
				售罄
			</button>
		</nav>
	);
}

export function MerchantOrderCard({
	order,
	now,
	isNew,
	isProcessing,
	onAction,
}: {
	order: MerchantOrder;
	now: Date;
	isNew: boolean;
	isProcessing: boolean;
	onAction: (action: "accept" | "reject" | "complete") => void;
}) {
	const deadline = getDeadlineState(order.estimatedReadyAt, now);
	const itemQuantity = order.items.reduce((total, item) => total + item.quantity, 0);

	return (
		<article
			className={`merchant-order urgency-${deadline.className}${order.specialOrder ? " special" : ""}${isNew ? " new-order" : ""}`}
		>
			<header className="merchant-order-heading">
				<div>
					<p className="merchant-order-number">#{order.orderNumber}</p>
					<p className={`merchant-deadline ${deadline.className}`}>{deadline.label}</p>
					<time dateTime={order.estimatedReadyAt}>預計 {formatReadyTime(order.estimatedReadyAt)} 完成</time>
				</div>
				<div className="merchant-order-signals">
					{itemQuantity >= LARGE_ORDER_QUANTITY && <strong>共 {itemQuantity} 份</strong>}
					{order.specialOrder && <span className="special-badge">特殊訂單</span>}
				</div>
			</header>

			<ul className="merchant-item-list">
				{order.items.map((item, index) => (
					<li key={`${order.id}-${index}`}>
						<div>
							<strong>{item.name} ×{item.quantity}</strong>
							{item.modifiers.length > 0 && (
								<p>{item.modifiers.map(modifierLabel).join(" · ")}</p>
							)}
						</div>
						<span>NT$ {item.lineTotal}</span>
					</li>
				))}
			</ul>

			{order.customerNote && (
				<section className="merchant-order-note" aria-label="訂單備註">
					<div><span aria-hidden="true">⚠ </span><strong>訂單備註</strong></div>
					<span>{order.customerNote}</span>
				</section>
			)}

			{order.packagingPreference === "separate_spicy" && (
				<section className="merchant-packaging-preference" aria-label="包裝方式">
					<strong>包裝方式</strong>
					<span>辣／不辣分袋</span>
				</section>
			)}

			<footer className="merchant-order-footer">
				<div>
					<span>{order.customerName}</span>
					<a href={`tel:${order.customerPhone}`}>{order.customerPhone}</a>
				</div>
				<strong>NT$ {order.total}</strong>
			</footer>

			<div className="merchant-actions">
				{order.status === "pending" ? (
					<>
						<button type="button" disabled={isProcessing} onClick={() => onAction("accept")}>
							接單
						</button>
						<button
							className="reject-button"
							type="button"
							disabled={isProcessing}
							onClick={() => onAction("reject")}
						>
							拒單
						</button>
					</>
				) : (
					<button type="button" disabled={isProcessing} onClick={() => onAction("complete")}>
						完成
					</button>
				)}
			</div>
		</article>
	);
}

function AvailabilityRows({
	items,
	processingControl,
	onToggle,
}: {
	items: MerchantMenuItem[];
	processingControl: string | null;
	onToggle: (item: MerchantMenuItem) => void;
}) {
	return (
		<ul className="merchant-availability-list">
			{items.map((item) => {
				const controlKey = `item-${item.id}`;
				return (
					<li key={item.id}>
						<div>
							<strong>{item.name}</strong>
							<span className={item.isAvailable ? "available" : "sold-out"}>
								{item.isAvailable ? "販售中" : "已售罄"}
							</span>
						</div>
						<button
							type="button"
							className={item.isAvailable ? "sold-out-button" : "restore-button"}
							aria-label={`${item.isAvailable ? "售罄" : "恢復"} ${item.name}`}
							disabled={processingControl !== null}
							onClick={() => onToggle(item)}
						>
							{processingControl === controlKey
								? "處理中…"
								: item.isAvailable
									? "售罄"
									: "恢復"}
						</button>
					</li>
				);
			})}
		</ul>
	);
}

export function MerchantAvailabilityScreen({
	categories,
	processingControl,
	onToggle,
}: {
	categories: MerchantMenuCategory[];
	processingControl: string | null;
	onToggle: (item: MerchantMenuItem) => void;
}) {
	const allItems = categories.flatMap((category) => category.items);
	const pinnedItems = allItems.filter((item) => item.isQuickSoldOut);

	return (
		<section className="merchant-availability" aria-labelledby="availability-heading">
			<header>
				<h2 id="availability-heading">商品售罄</h2>
				<p>只調整顧客目前是否可以加入商品。</p>
			</header>
			{pinnedItems.length > 0 && (
				<section className="merchant-pinned-items" aria-labelledby="pinned-items-heading">
					<h3 id="pinned-items-heading">快速售罄</h3>
					<AvailabilityRows items={pinnedItems} processingControl={processingControl} onToggle={onToggle} />
				</section>
			)}
			{categories.map((category) => (
				<section className="merchant-availability-category" key={category.id}>
					<h3>{category.name}</h3>
					<AvailabilityRows
						items={category.items}
						processingControl={processingControl}
						onToggle={onToggle}
					/>
				</section>
			))}
		</section>
	);
}
