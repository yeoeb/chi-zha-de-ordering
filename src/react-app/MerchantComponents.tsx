import { useState } from "react";
import {
	groupMerchantItemsBySpice,
	type MerchantMenuCategory,
	type MerchantMenuItem,
	type MerchantModifier,
	type MerchantOrder,
	type MerchantViewName,
} from "./merchant-operations";
import {
	formatTaipeiDeadlineDateTime,
	formatTaipeiDeadlineTime,
} from "./taipei-time";

const LARGE_ORDER_QUANTITY = 8;

function modifierLabel(modifier: MerchantModifier) {
	if (modifier.groupName.startsWith("特殊選項：")) return modifier.name;
	return `${modifier.groupName}：${modifier.name}`;
}

export function MerchantPrimaryNavigation({
	activeView,
	workflowView,
	pendingCount,
	acceptedCount,
	onChange,
}: {
	activeView: MerchantViewName;
	workflowView: "pending" | "accepted" | "history";
	pendingCount: number;
	acceptedCount: number;
	onChange: (view: "pending" | "accepted" | "availability") => void;
}) {
	return (
		<nav className="merchant-primary-nav" aria-label="店家主要功能">
			<button
				type="button"
				aria-current={activeView === "orders" && workflowView === "pending" ? "page" : undefined}
				onClick={() => onChange("pending")}
			>
				待接單 <strong>{pendingCount}</strong>
			</button>
			<button
				type="button"
				aria-current={activeView === "orders" && workflowView === "accepted" ? "page" : undefined}
				onClick={() => onChange("accepted")}
			>
				製作中 <strong>{acceptedCount}</strong>
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
	isNew,
	isProcessing,
	processingAction,
	onAction,
	onShortage,
}: {
	order: MerchantOrder;
	isNew: boolean;
	isProcessing: boolean;
	processingAction?: "accept" | "reject" | "complete" | null;
	onAction: (action: "accept" | "reject" | "complete") => void;
	onShortage?: (items: Array<{ orderItemId: string; quantity: number }>) => Promise<boolean>;
}) {
	const [shortageItemId, setShortageItemId] = useState<string | null>(null);
	const [shortageQuantity, setShortageQuantity] = useState(1);
	const itemQuantity = order.items.reduce((total, item) => total + item.quantity, 0);
	const isActiveOrder = order.status === "pending" || order.status === "accepted";
	const deadlineTime = formatTaipeiDeadlineTime(order.estimatedReadyAt);
	const deadlineDateTime = formatTaipeiDeadlineDateTime(order.estimatedReadyAt);
	const orderSource = order.orderSource ?? "online";
	const spiceGroups = groupMerchantItemsBySpice(order.items);
	const shortageItem = shortageItemId
		? order.items.find((item) => item.id === shortageItemId) ?? null
		: null;

	return (
		<article
			className={`merchant-order${order.specialOrder ? " special" : ""}${isNew ? " new-order" : ""}`}
			aria-label={`訂單 #${order.orderNumber}`}
			aria-busy={isProcessing}
		>
			<header className="merchant-order-heading">
				<div>
					<p className="merchant-primary-deadline">
						{isActiveOrder
							? deadlineTime ?? "截止時間未記錄"
							: deadlineDateTime ?? "截止時間未記錄"}
					</p>
					{!isActiveOrder && <p className="merchant-order-number">訂單 #{order.orderNumber}</p>}
					{!isActiveOrder && <p className="merchant-deadline history">
						{order.status === "completed" ? "已完成" : order.status === "cancelled" ? "已取消" : "已拒單"}
					</p>}
					{!isActiveOrder && deadlineDateTime && (
						<time dateTime={order.estimatedReadyAt}>截止 {deadlineDateTime}</time>
					)}
					{!isActiveOrder && <time dateTime={order.createdAt}>下單 {formatTaipeiDeadlineDateTime(order.createdAt) ?? "時間未記錄"}</time>}
				</div>
				<div className="merchant-order-signals">
					<span className={`order-source-badge source-${orderSource}`}>
						{orderSource === "onsite" ? "現場" : "網路"}
					</span>
					{order.status === "accepted" && (
						<strong className="merchant-active-total">NT$ {order.total}</strong>
					)}
					{(order.shortageRevision ?? 0) > 0 && <span className="merchant-adjusted-badge">已調整</span>}
					{!isActiveOrder && itemQuantity >= LARGE_ORDER_QUANTITY && <strong>共 {itemQuantity} 份</strong>}
					{!isActiveOrder && order.specialOrder && <span className="special-badge">特殊訂單</span>}
				</div>
			</header>

			{isActiveOrder ? (
				<div className="merchant-spice-groups">
					{spiceGroups.map((group) => (
						<section className={`merchant-spice-group spice-${group.className}`} key={group.name}>
							<h3>{group.name}</h3>
							<ul className="merchant-item-list">
								{group.items.map((item, index) => (
									<li key={item.id ?? `${order.id}-${group.name}-${index}`}>
										<div>
											<strong>{item.name} ×{item.quantity}</strong>
											{item.displayModifiers.length > 0 && (
												<p>{item.displayModifiers.map(modifierLabel).join(" · ")}</p>
											)}
										</div>
										{onShortage && item.id && (
											<button
												type="button"
												className="merchant-item-shortage-button"
												disabled={isProcessing}
												onClick={() => {
													setShortageItemId(item.id ?? null);
													setShortageQuantity(1);
												}}
											>
												缺貨
											</button>
										)}
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
			) : (
				<ul className="merchant-item-list">
					{order.items.map((item, index) => (
						<li key={item.id ?? `${order.id}-${index}`}>
							<div>
								<strong>{item.name} ×{item.quantity}</strong>
								{item.modifiers.length > 0 && <p>{item.modifiers.map(modifierLabel).join(" · ")}</p>}
							</div>
							<span>NT$ {item.lineTotal}</span>
						</li>
					))}
				</ul>
			)}

			{order.customerNote && (
				<section className="merchant-order-note" aria-label="訂單備註">
					<div><span aria-hidden="true">⚠ </span><strong>訂單備註</strong></div>
					<span>{order.customerNote}</span>
				</section>
			)}

			{(order.shortages?.length ?? 0) > 0 && (
				<section className="merchant-shortage-record">
					<strong>餐點調整</strong>
					{order.shortages!.map((shortage) => (
						<span key={shortage.orderItemId}>{shortage.name} 缺少 {shortage.quantity} 份</span>
					))}
					<span>原始 NT$ {order.originalTotal ?? order.total}・目前 NT$ {order.total}</span>
				</section>
			)}

			{isActiveOrder && onShortage && shortageItem?.id && (
				<div className="merchant-dialog-backdrop" role="presentation">
					<section className="merchant-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={`shortage-title-${shortageItem.id}`}>
						<h2 id={`shortage-title-${shortageItem.id}`}>確認品項缺貨？</h2>
						<p><strong>{shortageItem.name}</strong> 會同步設為售罄，後續新訂單將無法購買。</p>
						{shortageItem.quantity > 1 && (
							<label>
								<span>缺少數量</span>
								<select value={shortageQuantity} onChange={(event) => setShortageQuantity(Number(event.target.value))}>
									{Array.from({ length: shortageItem.quantity }, (_, index) => index + 1).map((quantity) => (
										<option key={quantity} value={quantity}>{quantity}</option>
									))}
								</select>
							</label>
						)}
						<div className="merchant-dialog-actions">
							<button type="button" disabled={isProcessing} onClick={() => setShortageItemId(null)}>返回</button>
							<button type="button" className="danger" disabled={isProcessing} onClick={async () => {
								if (await onShortage([{ orderItemId: shortageItem.id!, quantity: shortageQuantity }])) {
									setShortageItemId(null);
									setShortageQuantity(1);
								}
							}}>確認缺貨並停售</button>
						</div>
					</section>
				</div>
			)}

			{order.packagingPreference === "separate_spicy" && (
				<section className="merchant-packaging-preference" aria-label="包裝方式">
					<strong>包裝方式</strong>
					<span>辣／不辣分袋</span>
				</section>
			)}

			{!isActiveOrder && <footer className="merchant-order-footer">
				<div>
					{orderSource === "onsite" ? (
						<span>現場點餐（免留聯絡資料）</span>
					) : (
						<><span>{order.customerName}</span><a href={`tel:${order.customerPhone}`}>{order.customerPhone}</a></>
					)}
				</div>
				<strong>NT$ {order.total}</strong>
			</footer>}

			{isActiveOrder && <div className={`merchant-actions merchant-actions-${order.status}`}>
				{order.status === "pending" ? (
					<>
						<button className="accept-button" type="button" disabled={isProcessing} onClick={() => onAction("accept")}>
							{processingAction === "accept" ? "接單處理中…" : "接單"}
						</button>
						<button
							className="reject-button"
							type="button"
							disabled={isProcessing}
							onClick={() => onAction("reject")}
						>
							{processingAction === "reject" ? "拒單處理中…" : "拒單"}
						</button>
					</>
				) : order.status === "accepted" ? (
					<button type="button" disabled={isProcessing} onClick={() => onAction("complete")}>
						{processingAction === "complete" ? "完成處理中…" : "完成"}
					</button>
				) : null}
			</div>}
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
					<li key={item.id} className={item.isAvailable ? undefined : "is-sold-out"}>
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
