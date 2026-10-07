ALTER TABLE store_settings ADD COLUMN new_order_sound_enabled INTEGER NOT NULL DEFAULT 1
	CHECK (new_order_sound_enabled IN (0, 1));
