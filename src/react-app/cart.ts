export type SelectedModifier = {
	groupId: number;
	groupName: string;
	optionId: number;
	optionName: string;
	priceDelta: number;
};

export type CartLine = {
	id: string;
	menuItemId: number;
	itemName: string;
	selectedModifiers: SelectedModifier[];
	unitPrice: number;
	quantity: number;
};

type CartAction =
	| { type: "add"; line: Omit<CartLine, "quantity"> }
	| { type: "increase"; lineId: string }
	| { type: "decrease"; lineId: string }
	| { type: "remove"; lineId: string };

export function calculateUnitPrice(basePrice: number, modifiers: SelectedModifier[]) {
	return basePrice + modifiers.reduce((total, modifier) => total + modifier.priceDelta, 0);
}

export function createCartLine(
	item: { id: number; name: string; price: number },
	selectedModifiers: SelectedModifier[],
): Omit<CartLine, "quantity"> {
	const configurationKey = [...selectedModifiers]
		.sort((left, right) => left.groupId - right.groupId || left.optionId - right.optionId)
		.map((modifier) => `${modifier.groupId}=${modifier.optionId}`)
		.join("|");

	return {
		id: `${item.id}:${configurationKey}`,
		menuItemId: item.id,
		itemName: item.name,
		selectedModifiers,
		unitPrice: calculateUnitPrice(item.price, selectedModifiers),
	};
}

export function cartReducer(cart: CartLine[], action: CartAction): CartLine[] {
	switch (action.type) {
		case "add": {
			const existingLine = cart.find((line) => line.id === action.line.id);

			if (existingLine) {
				return cart.map((line) =>
					line.id === action.line.id ? { ...line, quantity: line.quantity + 1 } : line,
				);
			}

			return [...cart, { ...action.line, quantity: 1 }];
		}
		case "increase":
			return cart.map((line) =>
				line.id === action.lineId ? { ...line, quantity: line.quantity + 1 } : line,
			);
		case "decrease":
			return cart.map((line) =>
				line.id === action.lineId && line.quantity > 1
					? { ...line, quantity: line.quantity - 1 }
					: line,
			);
		case "remove":
			return cart.filter((line) => line.id !== action.lineId);
	}
}

export function getCartItemCount(cart: CartLine[]) {
	return cart.reduce((total, line) => total + line.quantity, 0);
}

export function getCartLineSubtotal(line: CartLine) {
	return line.unitPrice * line.quantity;
}

export function getCartTotal(cart: CartLine[]) {
	return cart.reduce((total, line) => total + getCartLineSubtotal(line), 0);
}
