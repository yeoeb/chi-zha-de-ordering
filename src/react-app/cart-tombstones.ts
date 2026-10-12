import type { CartLine } from "./cart";

export const CART_ZERO_TTL_MS = 1000;

// The entry object is a generation guard, not just an item ID or array position.
export class CartTombstoneTimers {
	private entries = new Map<string, { line: CartLine; timer: number }>();

	constructor(private readonly expire: (line: CartLine) => void) {}

	sync(lines: ReadonlyArray<CartLine>) {
		const current = new Map(lines.map((line) => [line.id, line]));
		for (const [id, entry] of this.entries) {
			if (current.get(id) !== entry.line || current.get(id)?.quantity !== 0) {
				window.clearTimeout(entry.timer);
				this.entries.delete(id);
			}
		}
		for (const line of lines) {
			if (line.quantity !== 0 || this.entries.has(line.id)) continue;
			const entry = { line, timer: 0 };
			entry.timer = window.setTimeout(() => {
				if (this.entries.get(line.id) !== entry) return;
				this.entries.delete(line.id);
				this.expire(line);
			}, CART_ZERO_TTL_MS);
			this.entries.set(line.id, entry);
		}
	}

	clear() {
		for (const entry of this.entries.values()) window.clearTimeout(entry.timer);
		this.entries.clear();
	}
}
