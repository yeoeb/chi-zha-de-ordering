-- Additive v0.1.1 spice choices for the three existing production spice groups.
-- Stable group/item relationships are checked before each insert.

INSERT INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
) SELECT 21, 1, '微辣', 0, 15, 1
WHERE EXISTS (
	SELECT 1 FROM modifier_groups AS groups
	JOIN menu_items AS items ON items.id = groups.menu_item_id
	WHERE groups.id = 1 AND groups.name = '辣度' AND items.id = 1 AND items.name = '香雞排'
) AND NOT EXISTS (SELECT 1 FROM modifier_options WHERE id = 21);

INSERT INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
) SELECT 22, 1, '辣粉另包', 0, 50, 1
WHERE EXISTS (
	SELECT 1 FROM modifier_groups AS groups
	JOIN menu_items AS items ON items.id = groups.menu_item_id
	WHERE groups.id = 1 AND groups.name = '辣度' AND items.id = 1 AND items.name = '香雞排'
) AND NOT EXISTS (SELECT 1 FROM modifier_options WHERE id = 22);

INSERT INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
) SELECT 23, 3, '微辣', 0, 15, 1
WHERE EXISTS (
	SELECT 1 FROM modifier_groups AS groups
	JOIN menu_items AS items ON items.id = groups.menu_item_id
	WHERE groups.id = 3 AND groups.name = '辣度' AND items.id = 4 AND items.name = '鹹酥雞'
) AND NOT EXISTS (SELECT 1 FROM modifier_options WHERE id = 23);

INSERT INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
) SELECT 24, 3, '辣粉另包', 0, 50, 1
WHERE EXISTS (
	SELECT 1 FROM modifier_groups AS groups
	JOIN menu_items AS items ON items.id = groups.menu_item_id
	WHERE groups.id = 3 AND groups.name = '辣度' AND items.id = 4 AND items.name = '鹹酥雞'
) AND NOT EXISTS (SELECT 1 FROM modifier_options WHERE id = 24);

INSERT INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
) SELECT 25, 4, '微辣', 0, 15, 1
WHERE EXISTS (
	SELECT 1 FROM modifier_groups AS groups
	JOIN menu_items AS items ON items.id = groups.menu_item_id
	WHERE groups.id = 4 AND groups.name = '辣度' AND items.id = 6 AND items.name = '甜不辣'
) AND NOT EXISTS (SELECT 1 FROM modifier_options WHERE id = 25);

INSERT INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
) SELECT 26, 4, '辣粉另包', 0, 50, 1
WHERE EXISTS (
	SELECT 1 FROM modifier_groups AS groups
	JOIN menu_items AS items ON items.id = groups.menu_item_id
	WHERE groups.id = 4 AND groups.name = '辣度' AND items.id = 6 AND items.name = '甜不辣'
) AND NOT EXISTS (SELECT 1 FROM modifier_options WHERE id = 26);
