import { uiCopy } from "./ui-copy";
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
	if (modifier.groupName === "辣度" && modifier.name === "辣粉另包") return modifier.name;
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
	workflowView: "pending" | "accepted";
	pendingCount: number;
	acceptedCount: number;
	onChange: (view: "pending" | "accepted" | "availability") => void;
}) {
	return (
		<nav className="merchant-primary-nav" aria-label={uiCopy.merchant.primaryNavigation}>
			<button
				type="button"
				aria-current={activeView === "orders" && workflowView === "pending" ? "page" : undefined}
				onClick={() => onChange("pending")}
			>
				{uiCopy.merchant.pending} <strong>{pendingCount}</strong>
			</button>
			<button
				type="button"
				aria-current={activeView === "orders" && workflowView === "accepted" ? "page" : undefined}
				onClick={() => onChange("accepted")}
			>
				{uiCopy.merchant.preparing} <strong>{acceptedCount}</strong>
			</button>
			<button
				type="button"
				aria-current={activeView === "availability" ? "page" : undefined}
				onClick={() => onChange("availability")}
			>
				{uiCopy.merchant.soldOut}
			</button>
		</nav>
	);
}

export function MerchantOrderCard({
	order,
	isNew,
	isProcessing,
	processingAction,
	isHistorical = false,
	embeddedHistory = false,
	onAction,
	onShortage,
	onOpenSecondary,
	onReturn,
}: {
	order: MerchantOrder;
	isNew: boolean;
	isProcessing: boolean;
	processingAction?: "accept" | "reject" | "complete" | null;
	isHistorical?: boolean;
	embeddedHistory?: boolean;
	onAction: (action: "accept" | "reject" | "complete") => void;
	onShortage?: (items: Array<{ orderItemId: string; quantity: number }>) => Promise<boolean>;
	onOpenSecondary?: () => void;
	onReturn?: () => void;
}) {
	const [shortageItemId, setShortageItemId] = useState<string | null>(null);
	const [shortageQuantity, setShortageQuantity] = useState(1);
	const itemQuantity = order.items.reduce((total, item) => total + item.quantity, 0);
	const isActiveOrder = !isHistorical && (order.status === "pending" || order.status === "accepted");
	const deadlineTime = formatTaipeiDeadlineTime(order.estimatedReadyAt);
	const deadlineDateTime = formatTaipeiDeadlineDateTime(order.estimatedReadyAt);
	const orderSource = order.orderSource ?? "online";
	const spiceGroups = groupMerchantItemsBySpice(order.items);
	const shortageItem = shortageItemId
		? order.items.find((item) => item.id === shortageItemId) ?? null
		: null;

	return (
		<article
			className={`merchant-order source-${orderSource}${order.specialOrder ? " special" : ""}${isNew ? " new-order" : ""}`}
			data-testid={`merchant-order-${order.id}`}
			aria-busy={isProcessing}
		>
			{!embeddedHistory && <header className="merchant-order-heading">
				<div>
					<p className="merchant-primary-deadline">
						{isActiveOrder
							? deadlineTime ?? uiCopy.common.deadlineMissing
							: deadlineDateTime ?? uiCopy.common.deadlineMissing}
					</p>
					{!isActiveOrder && <p className="merchant-deadline history">
						{order.status === "completed"
							? uiCopy.merchant.completed
							: order.status === "cancelled"
								? uiCopy.merchant.cancelled
								: order.status === "accepted"
									? uiCopy.merchant.pickupTimeReached
									: uiCopy.merchant.rejected}
					</p>}
				</div>
				<div className="merchant-order-signals">
					<span className={`order-source-badge source-${orderSource}`}>
						{orderSource === "onsite" ? uiCopy.merchant.onsite : uiCopy.merchant.online}
					</span>
					{order.status === "accepted" && (
						<strong className="merchant-active-total">NT$ {order.total}</strong>
					)}
					{(order.shortageRevision ?? 0) > 0 && <span className="merchant-adjusted-badge">{uiCopy.merchant.adjusted}</span>}
					{!isActiveOrder && itemQuantity >= LARGE_ORDER_QUANTITY && <strong>{uiCopy.merchant.largeOrderPrefix} {itemQuantity} {uiCopy.common.itemUnit}</strong>}
					{!isActiveOrder && order.specialOrder && <span className="special-badge">{uiCopy.merchant.specialOrder}</span>}
				</div>
			</header>}

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
													onOpenSecondary?.();
													setShortageItemId(item.id ?? null);
													setShortageQuantity(1);
												}}
											>
												{uiCopy.merchant.shortage}
											</button>
										)}
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
			) : (
				<div className="merchant-spice-groups merchant-history-spice-groups">
					{spiceGroups.map((group) => (
						<section className={`merchant-spice-group spice-${group.className}`} key={group.name}>
							<h3>{group.name}</h3>
							<ul className="merchant-item-list">
								{group.items.map((item, index) => (
									<li key={item.id ?? `${order.id}-${group.name}-${index}`}>
										<div>
											<strong>{item.name} ×{item.quantity}</strong>
											{item.displayModifiers.length > 0 && <p>{item.displayModifiers.map(modifierLabel).join(" · ")}</p>}
										</div>
										<span>NT$ {item.lineTotal}</span>
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
			)}

			{order.customerNote && (
				<section className="merchant-order-note" aria-label={uiCopy.common.orderNote}>
					<div><span aria-hidden="true">⚠ </span><strong>{uiCopy.common.orderNote}</strong></div>
					<span>{order.customerNote}</span>
				</section>
			)}

			{(order.shortages?.length ?? 0) > 0 && (
				<section className="merchant-shortage-record">
					<strong>{uiCopy.merchant.adjustment}</strong>
					{order.shortages!.map((shortage) => (
						<span key={shortage.orderItemId}>{shortage.name} {uiCopy.merchant.missingQuantityLabel} {shortage.quantity} {uiCopy.common.itemUnit}</span>
					))}
					<span>{uiCopy.merchant.originalAmountPrefix} {order.originalTotal ?? order.total}{uiCopy.merchant.currentAmountPrefix} {order.total}</span>
				</section>
			)}

			{isActiveOrder && onShortage && shortageItem?.id && (
				<div className="merchant-dialog-backdrop" role="presentation">
					<section className="merchant-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={`shortage-title-${shortageItem.id}`}>
						<h2 id={`shortage-title-${shortageItem.id}`}>{uiCopy.merchant.shortageTitle}</h2>
						<p><strong>{shortageItem.name}</strong> {uiCopy.merchant.shortageUnavailableHint}</p>
						{shortageItem.quantity > 1 && (
							<label>
								<span>{uiCopy.merchant.shortageQuantity}</span>
								<select value={shortageQuantity} onChange={(event) => setShortageQuantity(Number(event.target.value))}>
									{Array.from({ length: shortageItem.quantity }, (_, index) => index + 1).map((quantity) => (
										<option key={quantity} value={quantity}>{quantity}</option>
									))}
								</select>
							</label>
						)}
						<div className="merchant-dialog-actions">
							<button type="button" disabled={isProcessing} onClick={() => {
								setShortageItemId(null);
								onReturn?.();
							}}>{uiCopy.common.back}</button>
							<button type="button" className="danger" disabled={isProcessing} onClick={async () => {
								if (await onShortage([{ orderItemId: shortageItem.id!, quantity: shortageQuantity }])) {
									setShortageItemId(null);
									setShortageQuantity(1);
								}
							}}>{uiCopy.merchant.shortageConfirm}</button>
						</div>
					</section>
				</div>
			)}

			{order.packagingPreference === "separate_spicy" && (
				<section className="merchant-packaging-preference" aria-label={uiCopy.common.packaging}>
					<strong>{uiCopy.common.packaging}</strong>
					<span>{uiCopy.common.separateSpicyBags}</span>
				</section>
			)}

			{!isActiveOrder && !embeddedHistory && <footer className="merchant-order-footer">
				<span>{orderSource === "onsite" ? uiCopy.onsite.title : uiCopy.merchant.onlineOrder}</span>
				<strong>NT$ {order.total}</strong>
			</footer>}

			{(isActiveOrder || (isHistorical && order.status === "accepted")) && <div className={`merchant-actions merchant-actions-${order.status}`}>
				{order.status === "pending" ? (
					<>
						<button className={`accept-button source-${orderSource}`} type="button" disabled={isProcessing} onClick={() => onAction("accept")}>
							{processingAction === "accept" ? uiCopy.merchant.accepting : uiCopy.merchant.accept}
						</button>
						<button
							className="reject-button"
							type="button"
							disabled={isProcessing}
							onClick={() => onAction("reject")}
						>
							{processingAction === "reject" ? uiCopy.merchant.rejecting : uiCopy.merchant.reject}
						</button>
					</>
				) : order.status === "accepted" ? (
					<button type="button" disabled={isProcessing} onClick={() => onAction("complete")}>
						{processingAction === "complete" ? uiCopy.merchant.completing : uiCopy.merchant.complete}
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
								{item.isAvailable ? uiCopy.merchant.available : uiCopy.merchant.unavailable}
							</span>
						</div>
						<button
							type="button"
							className={item.isAvailable ? "sold-out-button" : "restore-button"}
							aria-label={`${item.isAvailable ? uiCopy.merchant.soldOut : uiCopy.merchant.restore} ${item.name}`}
							disabled={processingControl !== null}
							onClick={() => onToggle(item)}
						>
							{processingControl === controlKey
								? uiCopy.common.processing
								: item.isAvailable
									? uiCopy.merchant.soldOut
									: uiCopy.merchant.restore}
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
				<h2 id="availability-heading">{uiCopy.merchant.availabilityTitle}</h2>
				<p>{uiCopy.merchant.availabilityHint}</p>
			</header>
			{pinnedItems.length > 0 && (
				<section className="merchant-pinned-items" aria-labelledby="pinned-items-heading">
					<h3 id="pinned-items-heading">{uiCopy.merchant.quickSoldOut}</h3>
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
