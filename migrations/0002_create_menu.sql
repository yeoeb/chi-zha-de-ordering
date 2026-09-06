CREATE TABLE menu_categories (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL CHECK (length(trim(name)) > 0),
	sort_order INTEGER NOT NULL CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0),
	is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE menu_items (
	id INTEGER PRIMARY KEY,
	category_id INTEGER NOT NULL,
	name TEXT NOT NULL CHECK (length(trim(name)) > 0),
	description TEXT NOT NULL DEFAULT '',
	price INTEGER NOT NULL CHECK (typeof(price) = 'integer' AND price >= 0),
	sort_order INTEGER NOT NULL CHECK (typeof(sort_order) = 'integer' AND sort_order >= 0),
	is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
	FOREIGN KEY (category_id) REFERENCES menu_categories(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX menu_categories_active_sort_idx
	ON menu_categories (is_active, sort_order, id);

CREATE INDEX menu_items_category_sort_idx
	ON menu_items (category_id, sort_order, id);
