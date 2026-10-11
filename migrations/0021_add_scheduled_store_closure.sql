-- Additive only: never infer normal closure from legacy paused rows.
ALTER TABLE store_settings ADD COLUMN pause_reason TEXT;
ALTER TABLE store_settings ADD COLUMN scheduled_closed_business_date TEXT;
