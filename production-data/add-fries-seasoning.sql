-- Additive menu configuration for an existing single-store production database.
-- Apply only through a separately authorized production-data operation.

INSERT INTO modifier_groups (
	id, menu_item_id, name, selection_type, is_required, sort_order, is_active
) SELECT 5, id, '調味', 'single', 1, 20, 1
FROM menu_items
WHERE id = 9 AND name = '薯條'
	AND NOT EXISTS (SELECT 1 FROM modifier_groups WHERE id = 5);

INSERT INTO modifier_groups (
	id, menu_item_id, name, selection_type, is_required, sort_order, is_active
) SELECT 6, id, '調味', 'single', 1, 10, 1
FROM menu_items
WHERE id = 10 AND name = '甘梅地瓜'
	AND NOT EXISTS (SELECT 1 FROM modifier_groups WHERE id = 6);

INSERT INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
) SELECT 15, 5, '梅粉', 0, 10, 1
WHERE EXISTS (
	SELECT 1 FROM modifier_groups AS groups
	JOIN menu_items AS items ON items.id = groups.menu_item_id
	WHERE groups.id = 5 AND groups.name = '調味' AND items.id = 9 AND items.name = '薯條'
) AND NOT EXISTS (SELECT 1 FROM modifier_options WHERE id = 15);

INSERT INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
) SELECT 16, 5, '胡椒', 0, 20, 1
WHERE EXISTS (
	SELECT 1 FROM modifier_groups AS groups
	JOIN menu_items AS items ON items.id = groups.menu_item_id
	WHERE groups.id = 5 AND groups.name = '調味' AND items.id = 9 AND items.name = '薯條'
) AND NOT EXISTS (SELECT 1 FROM modifier_options WHERE id = 16);

INSERT INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
) SELECT 17, 5, '不加調味', 0, 30, 0
WHERE EXISTS (
	SELECT 1 FROM modifier_groups AS groups
	JOIN menu_items AS items ON items.id = groups.menu_item_id
	WHERE groups.id = 5 AND groups.name = '調味' AND items.id = 9 AND items.name = '薯條'
) AND NOT EXISTS (SELECT 1 FROM modifier_options WHERE id = 17);

INSERT INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
) SELECT 18, 6, '梅粉', 0, 10, 1
WHERE EXISTS (
	SELECT 1 FROM modifier_groups AS groups
	JOIN menu_items AS items ON items.id = groups.menu_item_id
	WHERE groups.id = 6 AND groups.name = '調味' AND items.id = 10 AND items.name = '甘梅地瓜'
) AND NOT EXISTS (SELECT 1 FROM modifier_options WHERE id = 18);

INSERT INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
) SELECT 19, 6, '胡椒', 0, 20, 1
WHERE EXISTS (
	SELECT 1 FROM modifier_groups AS groups
	JOIN menu_items AS items ON items.id = groups.menu_item_id
	WHERE groups.id = 6 AND groups.name = '調味' AND items.id = 10 AND items.name = '甘梅地瓜'
) AND NOT EXISTS (SELECT 1 FROM modifier_options WHERE id = 19);

INSERT INTO modifier_options (
	id, modifier_group_id, name, price_delta, sort_order, is_active
) SELECT 20, 6, '不加調味', 0, 30, 0
WHERE EXISTS (
	SELECT 1 FROM modifier_groups AS groups
	JOIN menu_items AS items ON items.id = groups.menu_item_id
	WHERE groups.id = 6 AND groups.name = '調味' AND items.id = 10 AND items.name = '甘梅地瓜'
) AND NOT EXISTS (SELECT 1 FROM modifier_options WHERE id = 20);

UPDATE modifier_options SET is_active = 0
WHERE (id = 17 AND modifier_group_id = 5 AND name = '不加調味')
	OR (id = 20 AND modifier_group_id = 6 AND name = '不加調味');
