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
- Current scope includes authoritative Checkout Quote, V1 Order creation, Merchant Order handling, customer Order status polling, manual item/store availability controls, and the CP5 production security foundation.
- Public Customer Order reads use only the opaque lookup token; do not expose internal Order IDs as a public lookup contract.
- Merchant routes must fail closed outside an explicit local-only bypass and must remain behind the documented Cloudflare Access boundary in production.
- Never log full customer phone numbers, public lookup tokens, authorization headers, Access JWTs, or credentials.
- Inventory quantities, notifications, payments, maps, analytics, PWA work, and deployment remain out of scope.
