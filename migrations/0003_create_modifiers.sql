CREATE TABLE modifier_groups (
	id INTEGER PRIMARY KEY,
	menu_item_id INTEGER NOT NULL,
	name TEXT NOT NULL CHECK (length(trim(name)) > 0),
	selection_type TEXT NOT NULL CHECK (selection_type = 'single'),
	is_required INTEGER NOT NULL DEFAULT 0 CHECK (is_required IN (0, 1)),
	sort_order INTEGER NOT NULL CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0),
	is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
	FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE modifier_options (
	id INTEGER PRIMARY KEY,
	modifier_group_id INTEGER NOT NULL,
	name TEXT NOT NULL CHECK (length(trim(name)) > 0),
	price_delta INTEGER NOT NULL DEFAULT 0 CHECK (typeof(price_delta) = 'integer'),
	sort_order INTEGER NOT NULL CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0),
	is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
	FOREIGN KEY (modifier_group_id) REFERENCES modifier_groups(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX modifier_groups_item_active_sort_idx
	ON modifier_groups (menu_item_id, is_active, sort_order, id);

CREATE INDEX modifier_options_group_active_sort_idx
	ON modifier_options (modifier_group_id, is_active, sort_order, id);
