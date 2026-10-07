-- Human-reviewed v0.1.1 menu mapping for existing stable production rows only.
-- This script intentionally preserves prices, availability, quick-sold-out flags,
-- modifier ownership and historical Order snapshots. Missing-price products are
-- documented for an owner decision and are not created here.

UPDATE menu_categories
SET name = '招牌炸物', sort_order = 10, is_active = 1
WHERE id = 1 AND name IN ('香炸類', '招牌炸物');

UPDATE menu_categories
SET name = '串類小品', sort_order = 20, is_active = 1
WHERE id = 2 AND name IN ('串類', '串類小品');

UPDATE menu_categories
SET name = '蔬菜', sort_order = 30, is_active = 1
WHERE id = 3 AND name IN ('蔬菜類', '蔬菜');

INSERT INTO menu_categories (id, name, sort_order, is_active)
SELECT 4, '雞排類', 40, 1
WHERE NOT EXISTS (SELECT 1 FROM menu_categories WHERE id = 4)
	AND NOT EXISTS (SELECT 1 FROM menu_categories WHERE name = '雞排類');

-- Confirmed same-product renames retain their stable IDs and prices.
UPDATE menu_items SET name = '傳統雞排', category_id = 4, sort_order = 10, is_archived = 0
WHERE id = 1 AND name IN ('香雞排', '傳統雞排')
	AND EXISTS (SELECT 1 FROM menu_categories WHERE id = 4 AND name = '雞排類');

UPDATE menu_items SET name = '香酥魷魚', is_archived = 0
WHERE id = 3 AND name IN ('魷魚', '香酥魷魚');

UPDATE menu_items SET name = '鹽酥雞', is_archived = 0
WHERE id = 4 AND name IN ('鹹酥雞', '鹽酥雞');

UPDATE menu_items SET description = '兩顆皮蛋', is_archived = 0
WHERE id = 5 AND name = '招牌炸蛋';

UPDATE menu_items SET name = '豬大腸', category_id = 1, sort_order = 180, is_archived = 0
WHERE id = 24 AND name IN ('豬大腸串', '豬大腸');

UPDATE menu_items SET name = '金針菇及高麗菜', category_id = 3, sort_order = 20, is_archived = 0
WHERE id = 35 AND name IN ('金針菇+高麗菜', '金針菇及高麗菜');

-- Popular is presentation metadata, never a duplicate Menu Item.
UPDATE menu_items SET is_popular = 0
WHERE id = 1 AND name = '傳統雞排';

UPDATE menu_items SET is_popular = 1
WHERE (id = 2 AND name = '雞蛋豆腐')
	OR (id = 3 AND name = '香酥魷魚')
	OR (id = 4 AND name = '鹽酥雞')
	OR (id = 5 AND name = '招牌炸蛋');

-- Canonical category and ordering for rows whose identity is unambiguous.
UPDATE menu_items SET is_archived = 0, category_id = 1, sort_order = CASE id
	WHEN 2 THEN 10 WHEN 4 THEN 20 WHEN 5 THEN 30 WHEN 3 THEN 40
	WHEN 6 THEN 50 WHEN 9 THEN 60 WHEN 10 THEN 70 WHEN 7 THEN 80
	WHEN 8 THEN 90 WHEN 11 THEN 100 WHEN 12 THEN 110 WHEN 14 THEN 120
	WHEN 15 THEN 130 WHEN 16 THEN 140 WHEN 20 THEN 170 ELSE sort_order END
WHERE id IN (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 20)
	AND EXISTS (SELECT 1 FROM menu_categories WHERE id = 1 AND name = '招牌炸物');

UPDATE menu_items SET is_archived = 0, category_id = 2, sort_order = CASE id
	WHEN 29 THEN 10 WHEN 13 THEN 20 WHEN 27 THEN 30 WHEN 26 THEN 40
	WHEN 30 THEN 60 WHEN 31 THEN 80 WHEN 33 THEN 90 WHEN 21 THEN 100
	WHEN 22 THEN 110 WHEN 23 THEN 120 WHEN 28 THEN 130 ELSE sort_order END
WHERE id IN (13, 21, 22, 23, 26, 27, 28, 29, 30, 31, 33)
	AND EXISTS (SELECT 1 FROM menu_categories WHERE id = 2 AND name = '串類小品');

UPDATE menu_items SET is_archived = 0, category_id = 3, sort_order = CASE id
	WHEN 37 THEN 10 WHEN 35 THEN 20 WHEN 36 THEN 30 WHEN 39 THEN 40
	WHEN 40 THEN 50 WHEN 42 THEN 60 ELSE sort_order END
WHERE id IN (35, 36, 37, 39, 40, 42)
	AND EXISTS (SELECT 1 FROM menu_categories WHERE id = 3 AND name = '蔬菜');

-- Products absent from the latest owner-supplied menu are archived, never deleted.
UPDATE menu_items SET is_archived = 1
WHERE (id = 19 AND name = '蝦片')
	OR (id = 25 AND name = '培根串')
	OR (id = 32 AND name = '鱈魚丸')
	OR (id = 34 AND name = '鴨腸串')
	OR (id = 38 AND name = '玉米筍')
	OR (id = 41 AND name = '大玉米');
