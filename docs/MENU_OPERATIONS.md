# Menu and image operations

## Authoritative model

Each Menu Item has a stable numeric ID independent of its display name. Current editable attributes include name, integer TWD base price, description, category, sort order, `image_url`, popular presentation, quick-sold-out presentation, archive state and availability. Archive controls lifecycle visibility; availability is the Merchant's daily sold-out source of truth. Popular and quick sold-out are separate presentation meanings and do not duplicate rows.

Modifier Groups belong to one Menu Item. Current meanings include portion, spice, seasoning and cut. A Modifier Option has a stable ID, sort order, active state, default state and price delta. Quote and Order validation verify ownership, active state, required selections and current prices; the UI must never invent option IDs.

## Historical integrity

Orders persist item and modifier snapshots: names, unit prices, quantities, option labels and deltas. Later menu rename, price, category, image, archive or availability changes must not rewrite history. Current menu rows are used only for new Quote/Order validation.

## Routine operations

Use `/admin/menu` for routine product/category edits and reviewed lifecycle changes. Use `/merchant` only for accepting/completing Orders and sold-out/restore operations. Do not run ad-hoc SQL for daily edits.

Versioned `production-data/*.sql` and migrations are reserved for reviewed, repeat-safe schema/configuration releases. Stable ID/name guards are required when attaching production modifier data. Historical modifier options should be made inactive rather than deleted when snapshots may reference them.

The owner-reviewed v0.1.1 mapping is documented in `OFFICIAL_MENU_MAPPING.md` and implemented by `production-data/apply-official-menu-v0.1.1.sql`. It must be applied only through a separately authorized production-data gate after `npm run verify:production-data` passes. It does not supply missing prices or resolve ambiguous product identities.

## Images

`image_url` stores metadata only. The image itself belongs in public HTTPS object/static storage; binary image data must not be stored in D1. Customer cards use `object-fit: cover` and a fallback when the URL is absent or fails. R2 upload is not part of this release.

## Current unresolved data

The requested 起士、香蔥、泡菜、泡菜起士 chicken-cutlet variants lack confirmed stable production IDs, prices, images, sort order and modifier applicability. They must not be created from guesses. The exact Uber Eats store category page was not reliably readable in this audit; category changes require shop-provided screenshot/text from that exact source.
