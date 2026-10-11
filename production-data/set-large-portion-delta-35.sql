-- Only the two identified large options. Never read or update base prices.
WITH targets AS (
 SELECT o.id FROM modifier_options o
 JOIN modifier_groups g ON g.id=o.modifier_group_id
 JOIN menu_items i ON i.id=g.menu_item_id
 WHERE o.name='大份' AND g.name='份量' AND (
  (o.id=28 AND g.id=7 AND i.id=4 AND i.name IN ('鹹酥雞','鹽酥雞')) OR
  (o.id=30 AND g.id=8 AND i.id=3 AND i.name='香酥魷魚')
 )
)
UPDATE modifier_options SET price_delta=35
WHERE id IN (SELECT id FROM targets) AND (SELECT COUNT(*) FROM targets)=2
 AND price_delta<>35;
