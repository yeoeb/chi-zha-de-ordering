CREATE TABLE store_settings (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
	is_accepting_orders INTEGER NOT NULL CHECK (is_accepting_orders IN (0, 1)),
	base_prep_minutes INTEGER NOT NULL CHECK (base_prep_minutes >= 0),
	normal_order_minutes INTEGER NOT NULL CHECK (normal_order_minutes >= 0),
	special_extra_minutes INTEGER NOT NULL CHECK (special_extra_minutes >= 0)
);

INSERT INTO store_settings (
	id,
	display_name,
	is_accepting_orders,
	base_prep_minutes,
	normal_order_minutes,
	special_extra_minutes
) VALUES (1, '吃炸的', 1, 15, 5, 10);
