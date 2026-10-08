# Saasly — TanStack fullstack SaaS dashboard

A realistic SaaS admin dashboard (customers, billing, projects/kanban, team, activity, analytics) built to compare
data-layer approaches. `main` is the **"classic heavy TanStack Query"** baseline; this branch (`tanstack-db`) moves the client data
layer to **TanStack DB** (collections + live queries + transactions) on top of the same Query client, server and API.

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

Environment knobs for the API: `API_LATENCY_MS` (default 250), `API_FAIL_RATE` (0–1, fails writes), `RESEED=1`, `DB_FILE`, `PORT`,
`NODE_ENV=production`, `DEMO_MODE=1` (see [Demo mode](#demo-mode)).
Latency and failure rate can also be changed live on the **Settings → Network simulation** page — handy for watching
optimistic updates and rollbacks.

## Data model (29 tables + 2 views)

| Area              | Tables                                                                                    | Notes                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Identity & access | `users`, `roles`, `permissions`, `role_permissions`, `sessions`, `teams`, `team_members`  | RBAC is data: permissions per role live in `role_permissions`; teams are many-to-many           |
| CRM               | `customers`, `contacts`, `tags`, `customer_tags`                                          | customers are **soft-deleted** (billing history must survive); tags are many-to-many            |
| Catalog & billing | `products`, `subscriptions`, `invoices`, `invoice_line_items`, `payments`                 | `payments` is an **append-only ledger**; line items are immutable                               |
| Delivery          | `projects`, `tasks`, `task_comments`, `time_entries`                                      | comments are **append-only** (a task with discussion can't be deleted)                          |
| Metering          | `usage_events`                                                                            | **append-only**, idempotent ingestion via `idempotency_key` (unique per customer)               |
| Rollups           | `customer_balances`, `usage_daily` (trigger-maintained), `mrr_snapshots` (job-maintained) | balances: open/overdue amounts **net of payments** (same as AR aging)                           |
| MRR ledger        | `mrr_movements` (+ `mrr_hold`, internal)                                                  | **append-only**: one row per change of `customers.mrr`; `mrr_snapshots` are derived from it     |
| Logs              | `events` (activity feed), `audit_log`, `notifications`                                    | `audit_log` is **append-only**, records every write, login and denied request with a field diff |
| Views             | `project_stats`, `customer_health`                                                        | SQL views joining tasks/time and customers/balances/usage                                       |

Business rules enforced by the database (triggers), so every write path obeys them:
`customers.mrr = Σ active subscriptions`, `invoices.amount = Σ line items`, an invoice becomes `paid` once payments cover
it, balances and daily usage roll up incrementally, every MRR change appends a movement (`new`, `expansion`,
`contraction`, `churn`, `reactivation`; a plan change is one net movement, trials count from conversion), and
append-only tables reject `UPDATE`/`DELETE`.

Other business rules (server-side): plan list prices come from `products.unit_price`; a base plan's status follows the
customer (change it there — `PATCH /subscriptions/:id {status}` on a base plan is a 409); churned customers can't take
add-ons and add-ons inherit the account's status; invoices with any payment can't be voided; `dueAt` is stored as UTC
(a date-only value means the end of that day) and open/overdue follows it; archiving a customer voids its unpaid open
invoices (409 while one is partially paid), and archived customers' rows disappear from every child resource.

## Auth & permissions

Cookie (or `Authorization: Bearer`) sessions, scrypt password hashes. Only a SHA-256 of each session token is stored;
the cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Failed sign-ins are throttled per email (429 after
10 failures for 15 minutes) and unknown accounts cost the same scrypt as known ones. Request ids (`x-request-id`
response header, `audit_log.request_id`) are always generated by the server.

Demo accounts (password `password`): `owner@`, `admin@`, `billing@`, `member@`, `viewer@saasly.dev` — the login page has
one-click buttons (demo mode only, see below).

| Role    | Highlights                                                                      |
| ------- | ------------------------------------------------------------------------------- |
| owner   | everything incl. developer tools                                                |
| admin   | everything except developer tools                                               |
| billing | subscriptions, invoices, payments, products, billing jobs (`billing:write`)     |
| member  | customers **they own**, projects **of their teams**, comments, own time entries |
| viewer  | read-only                                                                       |

Row-level rules (members editing only owned customers / team projects, own time entries, own notifications/sessions)
are enforced server-side in the resource registry; the UI mirrors them. Updates are checked against both the stored and
the patched row: members can't move a project to another team or give it to someone else, and a task's assignee
outside the project's team may only change its status/position. Every 403 is written to the audit log.

### Demo mode

Demo mode is on by default and **off when `NODE_ENV=production`** (set `DEMO_MODE=1` to force it on). Only in demo mode:

- `GET /api/auth/demo-users` (public, lists the demo accounts and their password),
- `/api/dev/{chaos,reset}` (developer tools, `admin:dev`),
- a database whose schema version doesn't match is **wiped and reseeded** on startup.

Outside demo mode these routes 404, and a schema-version mismatch on a non-empty database makes the server refuse to
start (migrate it, or start once with `RESEED=1` to replace it with demo data). A brand-new empty database just gets
the schema.

## API

Every table is a resource with the same surface (`GET /api/resources` lists them with their mode and permissions):

```
GET    /api/:resource            list: ?page&pageSize | ?limit&offset (≤ 10000 rows), ?sort=-a,b, ?q=, ?field=v1,v2, ?field[op]=v
GET    /api/:resource/:id        (composite keys like team-members/3:7)
POST   /api/:resource            create        (405 for read-only resources)
PATCH  /api/:resource/:id        update        (405 for append-only / read-only)
DELETE /api/:resource/:id        delete / soft delete
POST   /api/batch                atomic multi-entity writes (one SQLite transaction, same auth rules)
```

Business endpoints: `POST /api/auth/{login,logout}`, `GET /api/auth/me`, `POST /api/invoices/:id/pay`,
`POST /api/notifications/read-all`, `POST /api/jobs/{mark-overdue,rebuild-mrr}`, `GET /api/metrics/*`,
`GET /api/events/feed` (cursor; `type=invoice.` or `type=invoice` = a category, `type=invoice.paid` = one type),
`GET /api/events/stream` (SSE change feed: re-authorizes the session before every delivery and closes after logout or
deactivation; per-user rows such as sessions/notifications only reach their owner), `/api/dev/{chaos,reset}` (demo
mode). Client-chosen ids must be ≤ 2^52. Constraint violations answer with generic messages (409/400).

Writes run through a serialized writer (`BEGIN IMMEDIATE`) in Effect. The request body is read and validated _before_
the transaction starts and the transactional program runs synchronously, so no other request can observe or join an
open transaction and a slow client never holds the write lock; change messages are buffered in an outbox and published
only after commit.

## TanStack DB layer (this branch)

```
src/db/collections.ts  one collection per API resource (27 tables -> ~25 collections), built by two factories:
                         serverCollection()   eager: whole (permission-scoped) table, queried locally
                         onDemandCollection() loadSubset: where/orderBy/limit pushed down to the REST grammar
                       mode per resource: crud | append-only (payments, comments: insert only) | read-only
                       (rollups, line items, audit log, views) — enforced before any request; prefs/pins
                       (localStorage), selection (local-only); one atomic persist() -> POST /api/batch for
                       every handler; server-computed fields are stripped from what is sent and derived rows
                       (MRR from subscriptions, invoice settled by payment) are re-read after commit
src/db/pushdown.ts     live-query predicate -> REST list grammar (where/orderBy/limit/offset)
src/db/views.ts        materialized views (module-level live query collections) for dashboard aggregates
src/db/actions.ts      intent-level mutations: optimistic actions (record payment, add-on, mark paid),
                       multi-collection & staged transactions (archive customer + invoices, reassign tasks)
src/db/live.ts         permission-filtered SSE change feed -> direct writes (writeUpsert/writeDelete), no refetching
src/lib/auth.ts        sign-in / sign-out / 401 clear every server collection, view, cursor pager and the
                       selection, so no rows leak between users
```

Server rollup tables and views (`customer_balances`, `project_stats`, AR aging, product adoption, team rosters,
role matrix) become live joins/aggregates on the client, so they update the instant any underlying row changes.

`scripts/journey.mjs` replays the same 18-step signed-in user journey against either branch and reports requests/latency
(`BASE=http://localhost:4173 node scripts/journey.mjs`).
