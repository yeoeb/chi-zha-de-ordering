-- Human-approved initial production configuration for the single store 吃炸的.
-- This file is intentionally non-destructive and must never be replaced by
-- seeds/development.sql for production use.

UPDATE store_settings
SET
	display_name = '吃炸的',
	is_accepting_orders = CASE
		WHEN NOT EXISTS (SELECT 1 FROM menu_items) THEN 0
		ELSE is_accepting_orders
	END,
	base_prep_minutes = 15,
	normal_order_minutes = 5,
	special_extra_minutes = 10
WHERE id = 1;

INSERT OR IGNORE INTO menu_categories (id, name, sort_order, is_active) VALUES
	(1, '香炸類', 10, 1),
	(2, '串類', 20, 1),
	(3, '蔬菜類', 30, 1);

INSERT OR IGNORE INTO menu_items (
	id,
	category_id,
	name,
	description,
	price,
	sort_order,
	is_available
) VALUES
	(1, 1, '香雞排', '', 70, 10, 1),
	(2, 1, '雞蛋豆腐', '', 60, 20, 1),
	(3, 1, '魷魚', '', 60, 30, 1),
	(4, 1, '鹹酥雞', '', 60, 40, 1),
	(5, 1, '招牌炸蛋', '', 45, 50, 1),
	(6, 1, '甜不辣', '', 35, 60, 1),
	(7, 1, '傳統豆腐', '', 35, 70, 1),
	(8, 1, '雞皮', '', 35, 80, 1),
	(9, 1, '薯條', '', 35, 90, 1),
	(10, 1, '甘梅地瓜', '', 35, 100, 1),
	(11, 1, '百頁豆腐', '', 35, 110, 1),
	(12, 1, '蘿蔔糕', '', 35, 120, 1),
	(13, 1, '轟炸大魷魚', '', 90, 130, 1),
	(14, 1, '米血', '', 25, 140, 1),
	(15, 1, '銀絲卷', '', 25, 150, 1),
	(16, 1, '米腸', '', 25, 160, 1),
	(17, 1, '芋粿', '', 25, 170, 1),
	(18, 1, '芋粿巧', '', 20, 180, 1),
	(19, 1, '蝦片', '', 20, 190, 1),
	(20, 1, '豆皮', '', 20, 200, 1),
	(21, 1, '鑫鑫腸', '', 20, 210, 1),
	(22, 1, '雞脖子', '', 20, 220, 1),
	(23, 1, '豆干', '', 20, 230, 1),
	(24, 2, '豬大腸串', '', 45, 10, 1),
	(25, 2, '培根串', '', 40, 20, 1),
	(26, 2, '牛肉串', '', 40, 30, 1),
	(27, 2, '豬肉串', '', 35, 40, 1),
	(28, 2, '雞屁股', '', 30, 50, 1),
	(29, 2, '雞心', '', 25, 60, 1),
	(30, 2, '雞胗', '', 25, 70, 1),
	(31, 2, '貢丸', '', 25, 80, 1),
	(32, 2, '鱈魚丸', '', 25, 90, 1),
	(33, 2, '花枝丸', '', 25, 100, 1),
	(34, 2, '鴨腸串', '', 25, 110, 1),
	(35, 3, '金針菇+高麗菜', '', 55, 10, 1),
	(36, 3, '杏鮑菇', '', 45, 20, 1),
	(37, 3, '高麗菜', '', 45, 30, 1),
	(38, 3, '玉米筍', '', 40, 40, 1),
	(39, 3, '青花菜', '', 35, 50, 1),
	(40, 3, '四季豆', '', 35, 60, 1),
	(41, 3, '大玉米', '', 35, 70, 1),
	(42, 3, '小黃瓜', '', 35, 80, 1),
	(43, 3, '小青椒', '', 30, 90, 1);

-- Preserve the Phase 1 presentation configuration using authoritative data.
UPDATE menu_items SET is_popular = 1
WHERE (id = 1 AND name = '香雞排')
	OR (id = 4 AND name = '鹹酥雞');

INSERT OR IGNORE INTO modifier_groups (
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
	(3, 4, '辣度', 'single', 1, 10, 1),
	(4, 6, '辣度', 'single', 1, 10, 1),
	(5, 9, '調味', 'single', 1, 20, 1),
	(6, 10, '調味', 'single', 1, 10, 1);

INSERT OR IGNORE INTO modifier_options (
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
	(14, 4, '大辣', 0, 40, 1),
	(15, 5, '梅粉', 0, 10, 1),
	(16, 5, '胡椒', 0, 20, 1),
	(17, 5, '不加調味', 0, 30, 1),
	(18, 6, '梅粉', 0, 10, 1),
	(19, 6, '胡椒', 0, 20, 1),
	(20, 6, '不加調味', 0, 30, 1),
	(21, 1, '微辣', 0, 15, 1),
	(22, 1, '辣粉另包', 0, 50, 1),
	(23, 3, '微辣', 0, 15, 1),
	(24, 3, '辣粉另包', 0, 50, 1),
	(25, 4, '微辣', 0, 15, 1),
	(26, 4, '辣粉另包', 0, 50, 1);
