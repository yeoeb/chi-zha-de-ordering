# v0.1.1 official menu mapping

This mapping is based on the owner-supplied menu text and repository stable IDs. It deliberately preserves every existing price and Modifier relationship. No missing price is inferred.

## Confirmed existing rows

| Current ID | Old name | New name | Action | Canonical category | Modifier preserved? |
| --- | --- | --- | --- | --- | --- |
| 1 | 香雞排 | 傳統雞排 | RENAME + METADATA UPDATE | 雞排類 | Yes: spice group 1, cut group 2 |
| 2 | 雞蛋豆腐 | 雞蛋豆腐 | METADATA UPDATE | 招牌炸物 | Existing relationships unchanged |
| 3 | 魷魚 | 香酥魷魚 | RENAME + METADATA UPDATE | 招牌炸物 | Yes: portion group 8 |
| 4 | 鹹酥雞 | 鹽酥雞 | RENAME + METADATA UPDATE | 招牌炸物 | Yes: spice group 3, portion group 7 |
| 5 | 招牌炸蛋 | 招牌炸蛋 | METADATA UPDATE | 招牌炸物 | Description becomes `兩顆皮蛋` |
| 6–16, 20 | matching stable products | unchanged | KEEP / sort update | 招牌炸物 | Yes |
| 13, 21–23, 26–31, 33 | matching stable products | unchanged | METADATA UPDATE | 串類小品 | Yes |
| 24 | 豬大腸串 | 豬大腸 | RENAME + category update | 招牌炸物 | Existing relationships unchanged |
| 35 | 金針菇+高麗菜 | 金針菇及高麗菜 | RENAME | 蔬菜 | Existing relationships unchanged |
| 36, 37, 39, 40, 42 | matching stable products | unchanged | KEEP / sort update | 蔬菜 | Yes |
| 19, 25, 32, 34, 38, 41 | products absent from latest menu | unchanged | ARCHIVE | existing category retained | Historical snapshots unchanged |

`人氣精選` is generated from `is_popular`; it is not a second category row and does not duplicate products. Confirmed popular metadata is applied to IDs 2, 3, 4 and 5.

## Needs an owner decision

The following products are not created because the repository has no confirmed price/stable identity: 魚板、柳葉魚、章魚串、小香腸、起司雞排、香蔥雞排、泡菜起司雞排、蟹肉起司雞排 and the popular-list `蟹肉蔥雞排`.

The repository cannot prove whether `蟹肉蔥雞排` and `蟹肉起司雞排` are two products or one inconsistent name, so neither is merged nor duplicated. It also cannot prove that ID 17 `芋粿` is `甜芋粿`, ID 18 `芋粿巧` is `鹹芋粿`, or ID 43 `小青椒` is the requested `大青椒`; these rows are left unchanged pending confirmation.

## Safety

`production-data/apply-official-menu-v0.1.1.sql` contains guarded `INSERT`/`UPDATE` statements only. It changes no price, availability, quick-sold-out flag, Modifier ownership, Order row or Order snapshot. It is repeat-safe and must go through the production-data release gate before any remote execution.
