ALTER TABLE store_settings ADD COLUMN weekly_business_hours TEXT
	CHECK (
		weekly_business_hours IS NULL OR (
			typeof(weekly_business_hours) = 'text'
			AND weekly_business_hours = trim(weekly_business_hours)
			AND length(weekly_business_hours) BETWEEN 2 AND 2000
			AND json_valid(weekly_business_hours)
		)
	);

ALTER TABLE store_settings ADD COLUMN last_order_time TEXT
	CHECK (
		last_order_time IS NULL OR (
			typeof(last_order_time) = 'text'
			AND length(last_order_time) = 5
		)
	);

ALTER TABLE store_settings ADD COLUMN customer_phone_mode TEXT NOT NULL DEFAULT 'optional'
	CHECK (customer_phone_mode IN ('hidden', 'optional'));

ALTER TABLE store_settings ADD COLUMN show_product_images INTEGER NOT NULL DEFAULT 1
	CHECK (show_product_images IN (0, 1));
