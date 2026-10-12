# Portfolio screenshots — safe capture checklist

This document is for preparing interview-facing screenshots. Do not capture live Customer PII, Access cookies/tokens, real phone numbers from order data, or private admin credentials.

## What to capture

| Image filename | Page / Scenario | What it should demonstrate |
| --- | --- | --- |
| `docs/assets/customer-menu.png` | Customer on a mobile viewport | Categories, item card, red/yellow brand, price and portion selection |
| `docs/assets/customer-cart.png` | Customer checkout with seeded test data | Modifier selection, quantity and pricing, no real customer information |
| `docs/assets/merchant-workbench.png` | Merchant local/demo state | Pending, In Progress, deadline-focused ordering, sold-out controls |
| `docs/assets/admin-menu.png` | Admin local/demo state | Product price/image/category editing without production credentials |
| `docs/assets/architecture.png` (optional) | Diagram | Only if Mermaid cannot be used; do not fake runtime infrastructure |

## Capture guidance

1. Run a **local** seeded database or isolated test environment; never create fake orders in the live store just for screenshots.
2. In screenshots, remove or replace any real customer name/phone/order token, email address, admin authentication data and internal secrets.
3. Capture both narrow-mobile (e.g. 390px) and desktop/tablet where useful; avoid displaying Chrome DevTools and browser warnings in final images.
4. Check text is legible and representative of the current `main` UI. Do not use AI-generated mockups and present them as real app screenshots.
5. Compress PNGs before committing. Keep relevant screenshots versioned in `docs/assets/`.

## Once screenshots exist

Insert at the start of the main README below the intro:

```md
## 畫面預覽

| 顧客點餐 | 商家工作台 | Admin 後台 |
| --- | --- | --- |
| ![Customer](docs/assets/customer-menu.png) | ![Merchant](docs/assets/merchant-workbench.png) | ![Admin](docs/assets/admin-menu.png) |
```

## GitHub About checklist

GitHub repo home → **About** → gear/Edit:

- **Description**: `Production-oriented ordering & store operations system for a Taiwanese fried-food shop | React, TypeScript, Cloudflare Workers & D1`
- **Website**: `https://chizhade.com/`
- **Topics**: `react`, `typescript`, `cloudflare-workers`, `cloudflare-d1`, `hono`, `pwa`, `ordering-system`, `web-push`
- Leave the project Public only after reviewing sensitive values in commit history.
- Pin this repository on your GitHub profile (Profile → Customize your pins) if interviewers should see it first.
- GitHub About/profile settings are separate from this repository's README; don't change Cloudflare DNS or deploy in order to edit them.

Do not fabricate visitor counts, business performance, deployment status, or test results in the README.
