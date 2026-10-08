-- LOCAL / TEST / DEVELOPMENT ONLY.
-- Owner authorized these test prices as initial hotfix prices on 2026-10-09.
-- This remains a destructive LOCAL fixture. Never execute this destructive fixture against production D1.
-- Production uses the guarded scripts under production-data/ instead.

UPDATE store_settings SET
	is_accepting_orders = 1,
	weekly_business_hours = '{"0":{"isOpen":true,"openAt":"17:30","closeAt":"23:15"},"1":{"isOpen":false,"openAt":"17:30","closeAt":"23:15"},"2":{"isOpen":true,"openAt":"17:30","closeAt":"23:15"},"3":{"isOpen":true,"openAt":"17:30","closeAt":"23:15"},"4":{"isOpen":true,"openAt":"17:30","closeAt":"23:15"},"5":{"isOpen":true,"openAt":"17:30","closeAt":"23:15"},"6":{"isOpen":true,"openAt":"17:30","closeAt":"23:15"}}',
	last_order_time = '23:15',
	customer_phone_mode = 'optional',
	show_product_images = 1
WHERE id = 1;
DELETE FROM merchant_push_subscriptions;
DELETE FROM web_push_notification_deliveries;
DELETE FROM notification_deliveries;
DELETE FROM order_item_modifiers;
DELETE FROM order_item_shortages;
DELETE FROM order_shortage_requests;
DELETE FROM order_items;
DELETE FROM orders;
DELETE FROM modifier_options;
DELETE FROM modifier_groups;
DELETE FROM menu_items;
DELETE FROM menu_categories;

INSERT INTO menu_categories (id, name, sort_order, is_active) VALUES
	(1, '招牌炸物', 10, 1),
	(2, '串類小品', 20, 1),
	(3, '蔬菜', 30, 1),
	(4, '雞排類', 40, 1);

-- Existing production identities retain their stable IDs. IDs 44-53 are
-- deliberate new identities; 泡菜雞排 ID 53 starts at owner-confirmed 100.
INSERT INTO menu_items (
	id, category_id, name, description, price, sort_order, is_available,
	image_url, is_popular, is_quick_sold_out, is_archived
) VALUES
	(2, 1, '雞蛋豆腐', '', 60, 10, 1, NULL, 1, 0, 0),
	(4, 1, '鹽酥雞', '', 60, 20, 1, NULL, 1, 1, 0),
	(5, 1, '招牌炸蛋', '兩顆皮蛋', 60, 30, 1, NULL, 1, 0, 0),
	(3, 1, '香酥魷魚', '', 60, 40, 1, NULL, 1, 0, 0),
	(6, 1, '甜不辣', '', 40, 50, 1, NULL, 0, 0, 0),
	(9, 1, '薯條', '', 40, 60, 1, NULL, 0, 1, 0),
	(10, 1, '甘梅地瓜', '', 50, 70, 1, NULL, 0, 1, 0),
	(7, 1, '傳統豆腐', '', 40, 80, 1, NULL, 0, 0, 0),
	(8, 1, '雞皮', '', 40, 90, 1, NULL, 0, 0, 0),
	(11, 1, '百頁豆腐', '', 35, 100, 1, NULL, 0, 0, 0),
	(12, 1, '蘿蔔糕', '', 35, 110, 1, NULL, 0, 0, 0),
	(14, 1, '米血', '', 30, 120, 1, NULL, 0, 0, 0),
	(15, 1, '銀絲卷', '', 30, 130, 1, NULL, 0, 0, 0),
	(16, 1, '米腸', '', 35, 140, 1, NULL, 0, 0, 0),
	(17, 1, '甜芋粿', '', 30, 150, 1, NULL, 0, 0, 0),
	(18, 1, '鹹芋粿', '', 30, 160, 1, NULL, 0, 0, 0),
	(44, 1, '魚板', '', 30, 170, 1, NULL, 0, 0, 0),
	(20, 1, '豆皮', '', 30, 180, 1, NULL, 0, 0, 0),
	(24, 1, '豬大腸', '', 60, 190, 1, NULL, 0, 0, 0),
	(45, 1, '柳葉魚', '', 50, 200, 1, NULL, 0, 0, 0),

	(29, 2, '雞心', '', 35, 10, 1, NULL, 0, 0, 0),
	(13, 2, '轟炸大魷魚', '', 100, 20, 1, NULL, 0, 0, 0),
	(27, 2, '豬肉串', '', 40, 30, 1, NULL, 0, 0, 0),
	(26, 2, '牛肉串', '', 45, 40, 1, NULL, 0, 0, 0),
	(46, 2, '章魚串', '', 40, 50, 1, NULL, 0, 0, 0),
	(30, 2, '雞胗', '', 35, 60, 1, NULL, 0, 0, 0),
	(47, 2, '小香腸', '', 30, 70, 1, NULL, 0, 0, 0),
	(31, 2, '貢丸', '', 30, 80, 1, NULL, 0, 0, 0),
	(33, 2, '花枝丸', '', 30, 90, 1, NULL, 0, 0, 0),
	(21, 2, '鑫鑫腸', '', 30, 100, 1, NULL, 0, 0, 0),
	(22, 2, '雞脖子', '', 35, 110, 1, NULL, 0, 0, 0),
	(23, 2, '豆干', '', 25, 120, 1, NULL, 0, 0, 0),
	(28, 2, '雞屁股', '', 35, 130, 1, NULL, 0, 0, 0),

	(37, 3, '高麗菜', '', 50, 10, 1, NULL, 0, 1, 0),
	(35, 3, '金針菇及高麗菜', '', 60, 20, 1, NULL, 0, 0, 0),
	(36, 3, '杏鮑菇', '', 50, 30, 1, NULL, 0, 0, 0),
	(39, 3, '青花菜', '', 50, 40, 1, NULL, 0, 0, 0),
	(40, 3, '四季豆', '', 50, 50, 1, NULL, 0, 1, 0),
	(42, 3, '小黃瓜', '', 40, 60, 1, NULL, 0, 0, 0),
	(43, 3, '大青椒', '', 40, 70, 1, NULL, 0, 1, 0),

	(1, 4, '傳統雞排', '', 90, 10, 1, NULL, 0, 1, 0),
	(48, 4, '起司雞排', '不能切', 100, 20, 1, NULL, 0, 0, 0),
	(49, 4, '香蔥雞排', '不能切', 100, 30, 1, NULL, 0, 0, 0),
	(50, 4, '泡菜起司雞排', '不能切', 110, 50, 1, NULL, 0, 0, 0),
	(51, 4, '蟹肉起司雞排', '不能切', 110, 60, 1, NULL, 0, 0, 0),
	(52, 4, '蟹肉蔥雞排', '不能切', 110, 70, 1, NULL, 1, 0, 0),
	(53, 4, '泡菜雞排', '不能切', 100, 40, 1, NULL, 0, 0, 0);

INSERT INTO modifier_groups (
	id, menu_item_id, name, selection_type, is_required, sort_order, is_active
) VALUES
	(1, 1, '辣度', 'single', 1, 10, 1),
	(2, 1, '切法', 'single', 1, 20, 1),
	(3, 4, '辣度', 'single', 1, 10, 1),
	(4, 6, '辣度', 'single', 1, 10, 1),
	(5, 9, '調味', 'single', 1, 10, 1),
	(6, 10, '調味', 'single', 1, 10, 1),
	(7, 4, '份量', 'single', 1, 5, 1),
	(8, 3, '份量', 'single', 1, 5, 1);

INSERT INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
) VALUES
	(1, 1, '不辣', 0, 10, 1),
	(21, 1, '微辣', 0, 15, 1),
	(2, 1, '小辣', 0, 20, 1),
	(3, 1, '中辣', 0, 30, 1),
	(4, 1, '大辣', 0, 40, 1),
	(22, 1, '辣粉另包', 0, 50, 1),
	(5, 2, '不切', 0, 10, 1),
	(6, 2, '切', 0, 20, 1),
	(7, 3, '不辣', 0, 10, 1),
	(23, 3, '微辣', 0, 15, 1),
	(8, 3, '小辣', 0, 20, 1),
	(9, 3, '中辣', 0, 30, 1),
	(10, 3, '大辣', 0, 40, 1),
	(24, 3, '辣粉另包', 0, 50, 1),
	(11, 4, '不辣', 0, 10, 1),
	(25, 4, '微辣', 0, 15, 1),
	(12, 4, '小辣', 0, 20, 1),
	(13, 4, '中辣', 0, 30, 1),
	(14, 4, '大辣', 0, 40, 1),
	(26, 4, '辣粉另包', 0, 50, 1),
	(15, 5, '梅粉', 0, 10, 1),
	(16, 5, '胡椒', 0, 20, 1),
	(17, 5, '不加調味', 0, 30, 0),
	(18, 6, '梅粉', 0, 10, 1),
	(19, 6, '胡椒', 0, 20, 1),
	(20, 6, '不加調味', 0, 30, 0),
	(27, 7, '小份', 0, 10, 1),
	(28, 7, '大份', 40, 20, 1),
	(29, 8, '小份', 0, 10, 1),
	(30, 8, '大份', 40, 20, 1);
