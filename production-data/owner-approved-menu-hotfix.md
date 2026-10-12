# Owner-approved menu hotfix

On 2026-10-09 the owner authorized test menu prices as initial production prices, with future adjustments through Admin. The owner selected 100 for 泡菜雞排 (new stable ID 53). This supersedes the earlier restriction on test-only prices for this bounded hotfix.

`apply-owner-approved-menu-hotfix.sql` is a menu delta, not a seed or migration. Execute the complete file as one D1 query batch only after local verification and a fresh read-back. Its constraint guards accept exactly the audited prior menu or exactly the completed menu; unrelated drift fails closed. Do not split the batch or ignore a guard failure.

Existing item IDs are retained. IDs 44–52 retain their corresponding test products, including the two additional crab variants; ID 53 adds 泡菜雞排. Six retired products absent from the test menu are archived, never deleted. Prices, presentation order, categories and modifier ownership match the test menu. Existing availability, daily sold-out markers and image URLs remain unchanged. `is_quick_sold_out` is an Admin presentation flag for Merchant quick controls, not the current availability state.

All 47 active products except 招牌炸蛋 have exactly one complete spice group. 薯條 and 甘梅地瓜 present seasoning before spice. Cutting IDs 5/6 remain owned by 傳統雞排 only. The SQL never writes orders, historical snapshots, Store state, schedules, notification records or operational ledgers.

`npm run verify:production-data` retains the original production-data checks and adds the isolated D1 hotfix verifier: drift rejection, atomic batch rollback, repeat-safe application, stable IDs, complete spice and chicken coverage, preserved full historical rows, preserved Store/availability and quick_check. The audited prior menu fixture contains menu data only.
