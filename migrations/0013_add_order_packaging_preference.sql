ALTER TABLE orders ADD COLUMN packaging_preference TEXT NOT NULL DEFAULT 'together'
	CHECK (packaging_preference IN ('together', 'separate_spicy'));
