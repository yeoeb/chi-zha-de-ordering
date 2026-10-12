# 吃炸的 ordering system

Local-first baseline for the single-store 吃炸的 ordering system. It uses React, Vite, Hono, Cloudflare Workers, and a locally emulated Cloudflare D1 database.

The latest GitHub `main` is the stable development baseline. Start features on
`feature/*` and fixes on `fix/*`, then merge tested work through a reviewed PR.
GitHub updates do not deploy Cloudflare Production; an independent Release Gate
is required. See [Main development policy](docs/MAIN_DEVELOPMENT_POLICY.md).

## Local setup

```sh
npm install
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

The Vite development server serves the React SPA and runs `/api/*` through the Hono Worker. The default local URL is `http://localhost:5173`.

## Checks

```sh
npm run check
npm run verify
```

Local D1 data is stored under `.wrangler/` and is intentionally not committed.

If Windows PowerShell blocks the `npm.ps1` shim, use `npm.cmd` in place of `npm`.
