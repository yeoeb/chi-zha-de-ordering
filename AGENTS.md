# Project guidance

- Product: 吃炸的 (`chi-zha-de-ordering`), a single-store ordering system. Do not add multi-tenancy.
- Stack: TypeScript, React, Vite, Hono, Cloudflare Workers, and Cloudflare D1.
- Keep development local-first. Do not deploy, push, or add CI/CD or production infrastructure without an explicit task.
- Follow YAGNI and keep the Worker architecture minimal; add layers only when they solve a present need.
- The backend and D1 are the source of truth. Keep business rules out of React components.
- Client cart prices are display-only and untrusted. Checkout quotes and future Orders must recalculate authoritative prices from current D1 data through the shared backend boundary.
- Use ASCII identifiers in code and configuration; Chinese is allowed for display content.
- Do not hardcode environment-specific Cloudflare resource IDs for local development.
- Apply D1 migrations locally with `npm run db:migrate:local` and run `npm run check` before handoff.
- Current scope ends at an authoritative Checkout Quote and pure ETA policy with zero live queue counts. It excludes Order creation/storage, merchant UI, authentication, notifications, payments, maps, analytics, PWA work, and deployment.
