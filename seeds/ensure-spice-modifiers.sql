-- LOCAL ONLY: additive completion for the existing development menu.
-- Never run development.sql against an existing working DB to apply this delta.
-- Existing IDs, prices, availability, seasoning, cut and Order snapshots are preserved.
-- Stable item 5 is the confirmed 招牌炸蛋 exception. No IDs derive from display names.
INSERT INTO modifier_groups (menu_item_id, name, selection_type, is_required, sort_order, is_active)
SELECT items.id, '辣度', 'single', 1, CASE WHEN items.id IN (9, 10) THEN 20 ELSE 10 END, 1
FROM menu_items AS items
JOIN menu_categories AS categories ON categories.id = items.category_id
WHERE items.id <> 5 AND items.is_archived = 0 AND categories.is_active = 1
  AND EXISTS (SELECT 1 FROM menu_items WHERE id = 5 AND name = '招牌炸蛋')
  AND NOT EXISTS (SELECT 1 FROM modifier_groups WHERE menu_item_id = items.id AND name = '辣度');

UPDATE modifier_groups SET is_required = 1
WHERE name = '辣度' AND is_active = 1 AND menu_item_id <> 5
  AND EXISTS (SELECT 1 FROM menu_items WHERE id = 5 AND name = '招牌炸蛋');

WITH choices(name, sort_order) AS (
  VALUES ('不辣', 10), ('微辣', 15), ('小辣', 20), ('中辣', 30), ('大辣', 40), ('辣粉另包', 50)
)
INSERT INTO modifier_options (modifier_group_id, name, price_delta, sort_order, is_active)
SELECT groups.id, choices.name, 0, choices.sort_order, 1
FROM modifier_groups AS groups
JOIN menu_items AS items ON items.id = groups.menu_item_id
JOIN menu_categories AS categories ON categories.id = items.category_id
CROSS JOIN choices
WHERE groups.name = '辣度' AND groups.is_active = 1 AND items.id <> 5
  AND items.is_archived = 0 AND categories.is_active = 1
  AND EXISTS (SELECT 1 FROM menu_items WHERE id = 5 AND name = '招牌炸蛋')
  AND NOT EXISTS (SELECT 1 FROM modifier_options WHERE modifier_group_id = groups.id AND name = choices.name);
