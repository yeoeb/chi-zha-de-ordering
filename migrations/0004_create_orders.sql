CREATE TABLE orders (
	id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
	order_number TEXT NOT NULL UNIQUE CHECK (length(trim(order_number)) > 0),
	status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'completed', 'rejected')),
	total_amount INTEGER NOT NULL CHECK (typeof(total_amount) = 'integer' AND total_amount >= 0),
	estimated_ready_at TEXT NOT NULL CHECK (length(trim(estimated_ready_at)) > 0),
	created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
	accepted_at TEXT,
	completed_at TEXT,
	rejected_at TEXT,
	customer_name TEXT NOT NULL CHECK (length(trim(customer_name)) > 0),
	customer_phone TEXT NOT NULL CHECK (length(trim(customer_phone)) > 0),
	special_order INTEGER NOT NULL DEFAULT 0 CHECK (special_order IN (0, 1)),
	idempotency_key TEXT NOT NULL UNIQUE CHECK (length(trim(idempotency_key)) > 0),
	request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64)
);

CREATE TABLE order_items (
	id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
	order_id TEXT NOT NULL,
	menu_item_id INTEGER NOT NULL,
	item_name TEXT NOT NULL CHECK (length(trim(item_name)) > 0),
	unit_price INTEGER NOT NULL CHECK (typeof(unit_price) = 'integer' AND unit_price >= 0),
	quantity INTEGER NOT NULL CHECK (typeof(quantity) = 'integer' AND quantity > 0),
	line_total INTEGER NOT NULL CHECK (typeof(line_total) = 'integer' AND line_total >= 0),
	sort_order INTEGER NOT NULL CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0),
	FOREIGN KEY (order_id) REFERENCES orders(id) ON UPDATE RESTRICT ON DELETE CASCADE,
	FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE order_item_modifiers (
	id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
	order_item_id TEXT NOT NULL,
	modifier_option_id INTEGER NOT NULL,
	modifier_group_name TEXT NOT NULL CHECK (length(trim(modifier_group_name)) > 0),
	modifier_option_name TEXT NOT NULL CHECK (length(trim(modifier_option_name)) > 0),
	price_delta INTEGER NOT NULL CHECK (typeof(price_delta) = 'integer'),
	sort_order INTEGER NOT NULL CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0),
	FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON UPDATE RESTRICT ON DELETE CASCADE,
	FOREIGN KEY (modifier_option_id) REFERENCES modifier_options(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX orders_active_queue_idx
	ON orders (status, created_at, id);

CREATE INDEX order_items_order_idx
	ON order_items (order_id, sort_order, id);

CREATE INDEX order_item_modifiers_item_idx
	ON order_item_modifiers (order_item_id, sort_order, id);
