-- Optional production data step after migration 0012.
-- This preserves the two existing Phase 1 presentational 熱門 choices as
-- authoritative menu metadata. Review before any separately authorized remote run.
UPDATE menu_items
SET is_popular = 1
WHERE (id = 1 AND name = '香雞排')
	OR (id = 4 AND name = '鹹酥雞');
