import { uiCopy } from "./ui-copy";
import type { ReactNode } from "react";

export function DestructiveConfirmationDialog({
	title,
	description,
	children,
	dismissLabel,
	confirmLabel,
	isProcessing = false,
	onDismiss,
	onConfirm,
}: {
	title: string;
	description: string;
	children?: ReactNode;
	dismissLabel: string;
	confirmLabel: string;
	isProcessing?: boolean;
	onDismiss: () => void;
	onConfirm: () => void;
}) {
	const titleId = `destructive-title-${title.replace(/\s/g, "-")}`;
	const descriptionId = `${titleId}-description`;
	return (
		<div className="merchant-dialog-backdrop destructive-dialog-backdrop" role="presentation" onMouseDown={(event) => {
			if (event.target === event.currentTarget && !isProcessing) onDismiss();
		}}>
			<section className="merchant-confirm-dialog destructive-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
				<h2 id={titleId}>{title}</h2>
				<p id={descriptionId}>{description}</p>
				{children}
				<div className="merchant-dialog-actions">
					<button type="button" disabled={isProcessing} onClick={onDismiss}>{dismissLabel}</button>
					<button type="button" className="danger" disabled={isProcessing} onClick={onConfirm}>
						{isProcessing ? uiCopy.common.processing : confirmLabel}
					</button>
				</div>
			</section>
		</div>
	);
}
