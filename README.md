# Saasly — TanStack fullstack SaaS dashboard

A realistic SaaS admin dashboard (customers, billing, projects/kanban, team, activity, analytics) built to compare
data-layer approaches. This branch (`main`) is the **"classic heavy TanStack Query"** baseline.

| Layer     | Tech                                                                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Toolchain | **Vite+** (`vp dev / build / test / lint / fmt / check`) — Vite 8 + Rolldown, Vitest 5, Oxlint, Oxfmt                                                                                                                                                                                      |
| UI        | React 19.3 (client components only): `useActionState`, `useFormStatus`, `useOptimistic`, `useTransition`, `useDeferredValue`, `useEffectEvent`, `<Activity>`, `<ViewTransition>`, document `<title>`                                                                                       |
| Data      | TanStack Query 5.104 (`queryOptions`, `infiniteQueryOptions`, suspense, `useSuspenseQueries`, `useQueries`+`combine`, `keepPreviousData`, `select`, polling, `queryClient.query()` prefetching, cache-based optimistic updates + rollback, `useMutationState`, mutation `scope`, devtools) |
| Routing   | TanStack Router (typed params, validated search params as table state, loaders, intent preloading, `stripSearchParams`)                                                                                                                                                                    |
| Tables    | TanStack Table v9 (`tableFeatures`, server-side/manual pagination + sorting, row selection, column visibility, `table.FlexRender`)                                                                                                                                                         |
| Charts    | TanStack Charts 1.0 (`defineChart`, line/area, stacked/grouped bars, donut via `polar`, crosshair + tooltips)                                                                                                                                                                              |
| Server    | Node + Hono + **Effect 4** (services/layers, typed errors, `Schema` validation, `ManagedRuntime`) + SQLite (better-sqlite3)                                                                                                                                                                |
| Shared    | Effect `Schema` definitions used for both server request validation and client form validation (Standard Schema)                                                                                                                                                                           |
| Tests     | Vitest (server API against in-memory SQLite, client components with Testing Library) + Playwright E2E                                                                                                                                                                                      |

## Running

```bash
pnpm install
pnpm dev          # API on :3001 (seeded SQLite in ./data) + Vite+ dev server on :5173
pnpm test         # unit tests (vp test)
pnpm test:e2e     # builds, starts API + preview, runs Playwright
pnpm check        # vp check: format + lint + type-aware lint
pnpm typecheck    # tsc
```

Environment knobs for the API: `API_LATENCY_MS` (default 250), `API_FAIL_RATE` (0–1, fails writes), `RESEED=1`, `DB_FILE`, `PORT`.
Latency and failure rate can also be changed live on the **Settings → Network simulation** page — handy for watching
optimistic updates and rollbacks.

## Data model (27 tables + 2 views)

| Area              | Tables                                                                                    | Notes                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Identity & access | `users`, `roles`, `permissions`, `role_permissions`, `sessions`, `teams`, `team_members`  | RBAC is data: permissions per role live in `role_permissions`; teams are many-to-many           |
| CRM               | `customers`, `contacts`, `tags`, `customer_tags`                                          | customers are **soft-deleted** (billing history must survive); tags are many-to-many            |
| Catalog & billing | `products`, `subscriptions`, `invoices`, `invoice_line_items`, `payments`                 | `payments` is an **append-only ledger**; line items are immutable                               |
| Delivery          | `projects`, `tasks`, `task_comments`, `time_entries`                                      | comments are **append-only** (a task with discussion can't be deleted)                          |
| Metering          | `usage_events`                                                                            | **append-only**, idempotent ingestion via `idempotency_key`                                     |
| Rollups           | `customer_balances`, `usage_daily` (trigger-maintained), `mrr_snapshots` (job-maintained) |                                                                                                 |
| Logs              | `events` (activity feed), `audit_log`, `notifications`                                    | `audit_log` is **append-only**, records every write, login and denied request with a field diff |
| Views             | `project_stats`, `customer_health`                                                        | SQL views joining tasks/time and customers/balances/usage                                       |

Business rules enforced by the database (triggers), so every write path obeys them:
`customers.mrr = Σ active subscriptions`, `invoices.amount = Σ line items`, an invoice becomes `paid` once payments cover
it, balances and daily usage roll up incrementally, and append-only tables reject `UPDATE`/`DELETE`.

## Auth & permissions

Cookie (or `Authorization: Bearer`) sessions, scrypt password hashes. Demo accounts (password `password`):
`owner@`, `admin@`, `billing@`, `member@`, `viewer@saasly.dev` — the login page has one-click buttons.

| Role    | Highlights                                                                      |
| ------- | ------------------------------------------------------------------------------- |
| owner   | everything incl. developer tools                                                |
| admin   | everything except developer tools                                               |
| billing | subscriptions, invoices, payments, products, MRR jobs                           |
| member  | customers **they own**, projects **of their teams**, comments, own time entries |
| viewer  | read-only                                                                       |

Row-level rules (members editing only owned customers / team projects, own time entries, own notifications/sessions)
are enforced server-side in the resource registry; the UI mirrors them. Every 403 is written to the audit log.

## API

Every table is a resource with the same surface (`GET /api/resources` lists them with their mode and permissions):

```
GET    /api/:resource            list: ?page&pageSize | ?limit&offset, ?sort=-a,b, ?q=, ?field=v1,v2, ?field[op]=v
GET    /api/:resource/:id        (composite keys like team-members/3:7)
POST   /api/:resource            create        (405 for read-only resources)
PATCH  /api/:resource/:id        update        (405 for append-only / read-only)
DELETE /api/:resource/:id        delete / soft delete
POST   /api/batch                atomic multi-entity writes (one SQLite transaction, same auth rules)
```

Business endpoints: `POST /api/auth/{login,logout}`, `GET /api/auth/me`, `POST /api/invoices/:id/pay`,
`POST /api/notifications/read-all`, `POST /api/jobs/{mark-overdue,rebuild-mrr}`, `GET /api/metrics/*`,
`GET /api/events/feed` (cursor), `GET /api/events/stream` (SSE change feed, filtered per caller's permissions),
`/api/dev/{chaos,reset}`.

Writes run through a serialized writer (`BEGIN IMMEDIATE`) in Effect; change messages are buffered in an outbox and
published only after commit.
