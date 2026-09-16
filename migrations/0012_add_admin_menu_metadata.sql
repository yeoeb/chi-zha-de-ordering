ALTER TABLE menu_items ADD COLUMN image_url TEXT
	CHECK (
		image_url IS NULL OR (
			typeof(image_url) = 'text'
			AND image_url = trim(image_url)
			AND length(image_url) BETWEEN 1 AND 2048
		)
	);

ALTER TABLE menu_items ADD COLUMN is_popular INTEGER NOT NULL DEFAULT 0
	CHECK (is_popular IN (0, 1));

ALTER TABLE menu_items ADD COLUMN is_quick_sold_out INTEGER NOT NULL DEFAULT 0
	CHECK (is_quick_sold_out IN (0, 1));

ALTER TABLE menu_items ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0
	CHECK (is_archived IN (0, 1));

ALTER TABLE store_settings ADD COLUMN origin_disclosure TEXT
	CHECK (
		origin_disclosure IS NULL OR (
			typeof(origin_disclosure) = 'text'
			AND origin_disclosure = trim(origin_disclosure)
			AND length(origin_disclosure) BETWEEN 1 AND 500
		)
	);

CREATE INDEX menu_items_customer_visibility_sort_idx
	ON menu_items (is_archived, category_id, sort_order, id);
