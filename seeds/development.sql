-- Replaceable local development fixtures. SQLite booleans use 0 = false, 1 = true.
UPDATE store_settings SET is_accepting_orders = 1 WHERE id = 1;
DELETE FROM merchant_push_subscriptions;
DELETE FROM web_push_notification_deliveries;
DELETE FROM notification_deliveries;
DELETE FROM order_item_modifiers;
DELETE FROM order_items;
DELETE FROM orders;
DELETE FROM modifier_options;
DELETE FROM modifier_groups;
DELETE FROM menu_items;
DELETE FROM menu_categories;

INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES
	(1, '人氣', 10, 1),
	(2, '炸物', 20, 1);

INSERT INTO menu_items (
	id,
	category_id,
	name,
	description,
	price,
	sort_order,
	is_available
) VALUES
	(1, 1, '雞排', '', 85, 10, 1),
	(2, 1, '鹽酥雞', '', 70, 20, 1),
	(3, 2, '甜不辣', '', 40, 10, 1),
	(4, 2, '雞皮', '', 45, 20, 0),
	(5, 2, '薯條', '', 40, 30, 1);

INSERT INTO modifier_groups (
	id,
	menu_item_id,
	name,
	selection_type,
	is_required,
	sort_order,
	is_active
) VALUES
	(1, 1, '辣度', 'single', 1, 10, 1),
	(2, 1, '切法', 'single', 1, 20, 1),
	(3, 2, '辣度', 'single', 1, 10, 1),
	(4, 3, '辣度', 'single', 1, 10, 1);

INSERT INTO modifier_options (
	id,
	modifier_group_id,
	name,
	price_delta,
	sort_order,
	is_active
) VALUES
	(1, 1, '不辣', 0, 10, 1),
	(2, 1, '小辣', 0, 20, 1),
	(3, 1, '中辣', 0, 30, 1),
	(4, 1, '大辣', 0, 40, 1),
	(5, 2, '不切', 0, 10, 1),
	(6, 2, '切', 0, 20, 1),
	(7, 3, '不辣', 0, 10, 1),
	(8, 3, '小辣', 0, 20, 1),
	(9, 3, '中辣', 0, 30, 1),
	(10, 3, '大辣', 0, 40, 1),
	(11, 4, '不辣', 0, 10, 1),
	(12, 4, '小辣', 0, 20, 1),
	(13, 4, '中辣', 0, 30, 1),
	(14, 4, '大辣', 0, 40, 1);
