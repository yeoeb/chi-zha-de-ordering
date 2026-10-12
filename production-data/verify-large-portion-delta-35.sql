-- Read-only release verification. Both target identities must be present and delta must be 35.
SELECT i.id AS item_id,i.name AS item_name,g.id AS group_id,g.name AS group_name,
 o.id AS option_id,o.name AS option_name,o.price_delta
FROM modifier_options o JOIN modifier_groups g ON g.id=o.modifier_group_id
JOIN menu_items i ON i.id=g.menu_item_id
WHERE o.name='大份' AND g.name='份量' AND (
 (o.id=28 AND g.id=7 AND i.id=4 AND i.name IN ('鹹酥雞','鹽酥雞')) OR
 (o.id=30 AND g.id=8 AND i.id=3 AND i.name='香酥魷魚')) ORDER BY o.id;
PRAGMA quick_check;
