// Modifier semantics are independent of order source and generic control styles.
export const spicePresentation: Record<string, { order: number; className: string }> = {
	"不辣": { order: 0, className: "none" },
	"微辣": { order: 1, className: "mild" },
	"小辣": { order: 2, className: "small" },
	"中辣": { order: 3, className: "medium" },
	"大辣": { order: 4, className: "large" },
};

export function spiceSemanticClass(name: string) {
	return `spice-${spicePresentation[name]?.className ?? "other"}`;
}
