-- Human-reviewed portion options for existing stable production items only.
-- Item 4 (鹹酥雞) and item 3 (魷魚) both have an existing NT$60 small portion.
-- The NT$40 price delta makes the confirmed large portion NT$100.
INSERT OR IGNORE INTO modifier_groups (
	id, menu_item_id, name, selection_type, is_required, sort_order, is_active
)
SELECT 7, 4, '份量', 'single', 1, 5, 1
WHERE EXISTS (SELECT 1 FROM menu_items WHERE id = 4 AND name = '鹹酥雞' AND price = 60);

INSERT OR IGNORE INTO modifier_groups (
	id, menu_item_id, name, selection_type, is_required, sort_order, is_active
)
SELECT 8, 3, '份量', 'single', 1, 5, 1
WHERE EXISTS (SELECT 1 FROM menu_items WHERE id = 3 AND name = '魷魚' AND price = 60);

INSERT OR IGNORE INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
)
SELECT 27, 7, '小份', 0, 10, 1
WHERE EXISTS (SELECT 1 FROM modifier_groups WHERE id = 7 AND menu_item_id = 4 AND name = '份量');

INSERT OR IGNORE INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
)
SELECT 28, 7, '大份', 40, 20, 1
WHERE EXISTS (SELECT 1 FROM modifier_groups WHERE id = 7 AND menu_item_id = 4 AND name = '份量');

INSERT OR IGNORE INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
)
SELECT 29, 8, '小份', 0, 10, 1
WHERE EXISTS (SELECT 1 FROM modifier_groups WHERE id = 8 AND menu_item_id = 3 AND name = '份量');

INSERT OR IGNORE INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
)
SELECT 30, 8, '大份', 40, 20, 1
WHERE EXISTS (SELECT 1 FROM modifier_groups WHERE id = 8 AND menu_item_id = 3 AND name = '份量');
