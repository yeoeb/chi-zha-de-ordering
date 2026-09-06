# Project state

## Current phase

CP2A — Checkout Quote + ETA Policy implemented.

- CP0 — Initial Local Baseline: complete.
- CP1 — Menu + Modifier + Client Cart: complete and verified.
- CP2A — Checkout Quote + ETA Policy: implemented.

## Implemented features

- React SPA served by Vite with the Cloudflare Vite plugin.
- Hono Worker API with explicit Worker-first routing for `/api/*`.
- Local D1 binding named `DB`; no remote Cloudflare resource ID is configured.
- Single-store settings stored in D1 and exposed through the API.
- Active menu categories, items, modifier groups, and modifier options are grouped and deterministically sorted by the backend.
- Mobile-first menu with sold-out handling and required single-choice item configuration.
- In-memory client cart with configuration-aware line identity, quantity changes, removal, item count, subtotals, and total.
- Backend-authoritative checkout quote with current D1 names, availability, modifier relationships, integer prices, line totals, and cart total.
- Minimal Checkout/Review view that requests a fresh quote, displays the backend total and estimated ready time, and lets the customer return to edit the Cart.
- Pure preparation-time policy with a UTC ISO-8601 absolute ready timestamp.
- Reusable schema migrations are separate from replaceable local development fixtures.

## Current schema

- `store_settings`: the single row for store identity, accepting-orders state, and preparation timing settings.
- `menu_categories`: category name, deterministic sort order, and active state.
- `menu_items`: category foreign key, name, description, integer TWD price, deterministic sort order, and availability.
- `modifier_groups`: menu item foreign key, name, `single` selection type, required state, deterministic sort order, and active state.
- `modifier_options`: modifier group foreign key, name, integer TWD price delta, deterministic sort order, and active state.

SQLite boolean fields use constrained `0`/`1` values. No inventory, stock quantity, image, combo, promotion, coupon, order, or checkout schema exists.

## Current API

- `GET /api/health`: health response.
- `GET /api/store`: single-store settings.
- `GET /api/menu`: active categories and items with nested active modifier groups/options. The backend controls all relationships and ordering. Unavailable menu items remain present with `isAvailable: false`.
- `POST /api/checkout/quote`: accepts only menu item IDs, quantities, and modifier option IDs. It validates current D1 data and returns normalized items, authoritative integer prices, total, lead minutes, and an absolute `estimatedReadyAt` timestamp. It does not create an Order.

## Cart and pricing

- Cart state is held only in React memory; it is not stored in D1 or localStorage.
- A cart line ID is derived deterministically from the menu item ID and sorted selected modifier group/option IDs.
- Identical configurations merge by increasing quantity; different configurations remain separate lines.
- Client unit prices equal the menu item price plus selected modifier price deltas. Subtotals and cart totals are calculated locally for immediate display only.
- Client cart prices are non-authoritative and must never be trusted when creating an Order.
- Checkout Quote reloads current menu/modifier data from D1 and recalculates authoritative prices through `validateAndPriceCart`.
- Future Order creation must reuse this validation/pricing boundary instead of implementing a second pricing algorithm.

## Preparation time policy

- V1 formula: `leadMinutes = basePrepMinutes + ordersAhead * normalOrderMinutes + specialOrdersAhead * specialExtraMinutes`.
- A special Order contributes both the normal amount and the special extra amount.
- `specialOrdersAhead` must not exceed `ordersAhead`, and lead time cannot be less than `basePrepMinutes`.
- `estimatedReadyAt` is returned as an absolute UTC ISO-8601 timestamp calculated from an injected/current `now` value.
- CP2A has no Order tables, so the live Checkout Quote intentionally uses `ordersAhead = 0` and `specialOrdersAhead = 0`. CP2B will derive these counts from active Order rows.

## Architectural decisions

- The Worker remains a single Hono route file; current complexity still does not justify repository, service, or controller layers.
- `/api/menu` uses one ordered query and performs grouping in the Worker, avoiding per-item requests and N+1 behavior.
- Modifier selection currently supports only `single`; multi-choice and nested modifier abstractions are intentionally absent.
- Cart transitions and display-price calculations are isolated in a small pure reducer/helper module without a state library.
- Required single-choice modifier validation is a small pure frontend-domain helper used by React; one option ID can be retained per group.
- Authoritative validation and pricing live in a reusable Worker module, separate from the Hono route, so Checkout Quote and future Order creation share one trust boundary.
- Preparation-time calculation is pure logic separate from React, routing, and persistence.
- Static asset fallback remains SPA-based while `/api/*` always reaches the Worker first.

## Test approach

- Vitest runs through the official `@cloudflare/vitest-plugin` Workers integration.
- Worker API tests apply the real migrations to an isolated local D1 database and insert deterministic test-only fixtures.
- API coverage verifies active filtering, unavailable-item visibility, backend relationships and ordering, CP0 endpoint regressions, and Worker 404 behavior.
- Pure tests cover required single-choice validation, configuration-aware cart identity and merging, quantity transitions/removal, and integer price calculations.
- Checkout tests use isolated D1 fixtures to cover authoritative pricing, request trust boundaries, item/modifier validity, required/single-choice rules, duplicate options, and quantity bounds.
- Preparation-time tests pass a fixed clock and cover zero/non-zero queues, invalid queue relationships, minimum lead time, and exact absolute timestamps.
- Browser end-to-end tooling remains intentionally deferred; verification uses focused integration/unit tests and local HTTP smoke checks.

## Next feature

CP2B — Order Creation. Define the minimal Order schema and creation contract, reuse `validateAndPriceCart`, persist authoritative price snapshots, and derive ETA queue counts from active Order rows. Do not add merchant UI, authentication, notifications, payment, or deployment unless separately scoped.
