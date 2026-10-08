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

## Scale: millions of rows

```bash
pnpm db:big                      # data/big.db: 250k customers, ~13M rows, ~1.9 GB, ~4 min
DB_FILE=data/big.db pnpm dev     # run the app against it
pnpm bench:api                   # time every API request the clients make, against data/big.db
```

`scripts/seed-big.ts` runs the regular seed with big numbers, so the data flows through the same triggers: every rollup,
ledger and history table stays consistent. Tables over a million rows: `usage_events` (2.8M), `usage_daily` (2.2M),
`invoice_line_items` (1.7M), `events` (1.5M), `invoices` (1.1M), `payments` (1.1M), `audit_log` (1M). (Settings → Reset
database re-seeds the _small_ dataset.)

What made it fast (`pnpm bench:api`, median of 5, in-process, before → after, ms):

- **Archived-customer scope**: child resources were filtered with `customer_id IN (every live customer)`, which listed 250k
  ids on every request (60–115 ms even for one customer's rows). Archived customers are the small set, so it is now
  `NOT IN (archived)` with a partial index on them.
- **Partial covering indexes** on `customers … WHERE deleted_at IS NULL` for each filter/sort/aggregate path (lists only
  read live customers), covering indexes for invoice counts/totals, `(status, due_at)`, `(entity, at)` on the audit log.
  One covering index per access path: an overlapping narrower one made the planner pick 250k table lookups (4× slower).
- **Trigram full-text index** (`customers_fts`, FTS5 `tokenize='trigram'`) answers the same `LIKE '%term%'` search from an
  index (tested to return exactly the same rows); terms under 3 characters still scan.
- **Revenue rollup** `revenue_monthly`, kept exact by an insert trigger on the append-only ledger, instead of grouping a
  million payments per request. Date-range predicates instead of `substr()` over every row.

| area      | request                         | before | after |
| --------- | ------------------------------- | ------ | ----- |
| customers | first page (newest)             | 61.9   | 34.2  |
| customers | status+plan filter, sort by MRR | 108.6  | 7.1   |
| customers | search "labs"                   | 157.7  | 50.7  |
| customers | search "zz" (no match)          | 707.9  | 699.8 |
| customers | sort by owner name              | 111.2  | 120.5 |
| customers | country filter, sort by company | 61.4   | 3.1   |
| customers | deep page (offset 100k)         | 229    | 314.1 |
| customers | count only                      | 24.4   | 29.7  |
| customers | eager load (limit 10000)        | 139.4  | 125.1 |
| invoices  | first page                      | 598.7  | 135.7 |
| invoices  | status=overdue                  | 664.5  | 6     |
| invoices  | search company "labs"           | 1433.8 | 189.8 |
| invoices  | sort by customer company        | 816.3  | 540.3 |
| invoices  | one customer                    | 115.2  | 1.1   |
| invoices  | eager load (limit 10000)        | 565.4  | 132.1 |
| ledger    | payments, newest 10             | 417.5  | 59.4  |
| ledger    | payments of one invoice         | 0.8    | 1     |
| activity  | feed, first page                | 1.6    | 1.5   |
| activity  | feed, invoice category          | 1.2    | 1.1   |
| activity  | one customer, newest 20         | 0.9    | 0.9   |
| usage     | one customer daily api_calls    | 116.6  | 0.9   |
| usage     | one customer health (view)      | 0.9    | 1.4   |
| audit     | first page                      | 1.4    | 1.5   |
| audit     | filter entity=customers         | 39.3   | 37.8  |
| metrics   | overview                        | 198.1  | 89.3  |
| metrics   | revenue, 12 months              | 877.3  | 0.9   |
| metrics   | signups, 12 months              | 181.2  | 166.2 |
| metrics   | breakdown by country            | 126.2  | 44    |
| metrics   | breakdown by status, plan=pro   | 90     | 10.1  |
| metrics   | AR aging                        | 199.9  | 193.2 |
| metrics   | workload                        | 1.4    | 1.3   |
| billing   | MRR snapshots                   | 0.9    | 0.9   |
| detail    | customer                        | 0.8    | 1     |
| detail    | balance                         | 58.1   | 0.8   |

Still slow by nature (documented, not hidden): 1–2 character searches (full scan), sorting 250k customers by owner name or
1.1M invoices by customer company (a sort over a joined column — would need denormalising), deep `OFFSET` pages, and exact
`COUNT(*)`/`SUM` over every row of a million-row table on unfiltered lists (~90 ms).

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
src/db/collections.ts  one collection per API resource, built by two factories:
                         serverCollection()   eager: the whole (permission-scoped) table, queried locally
                         onDemandCollection() query-driven: each live query's where/orderBy/limit is
                                              pushed down (loadSubset) and only those rows are held
                       mode per resource: crud | append-only (payments, comments: insert only) | read-only
                       (rollups, line items, audit log, views) — enforced before any request; prefs/pins
                       (localStorage), selection (local-only); one atomic persist() -> POST /api/batch for
                       every handler; server-computed fields are stripped from what is sent and derived rows
                       (MRR from subscriptions, invoice settled by payment) are re-read after commit
src/db/pushdown.ts     live-query predicate -> REST list grammar (where/orderBy/limit/offset, search, sort keys)
src/db/aggregates.ts   server aggregates over the big tables: /metrics/*, list totals (?limit=0&sum=)
src/db/actions.ts      intent-level mutations: optimistic actions (record payment, add-on, mark paid),
                       multi-collection & staged transactions (archive customer + invoices, reassign tasks)
src/db/live.ts         permission-filtered SSE change feed -> batched direct writes of loaded rows,
                       window re-reads for rows not held, debounced invalidation of server aggregates
src/db/alerts.ts       churn / $20k MRR alerts from server rows as they land (SSE and batch results)
src/lib/auth.ts        sign-in / sign-out / 401 clear every server collection, cached query, cursor pager
                       and the selection, so no rows leak between users
```

### Eager vs on-demand

With `pnpm db:big` (250k customers, ~13M rows) "load the table, query it locally" stops being an option: the server
serves at most 10,000 rows per request, so an eager customers collection was silently a 4% sample (MRR $9.0M instead of
$557M) and loading everything would be ~70 MB of customers and ~200 MB of invoices as JSON. So:

| collections                                                                                                                                                                        | sync          | why                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------- |
| users, roles, permissions, role-permissions, teams, team-members, sessions (own), notifications (own), tags, products, projects, tasks, time entries, task comments, MRR snapshots | eager         | bounded (tens to a few thousand rows); local joins, aggregates, optimistic UI |
| customers, contacts, customer-tags, subscriptions, invoices, invoice line items, payments, usage-daily, customer-health, audit log, events (+ per-category)                        | **on-demand** | 100k–3M rows at scale; only the windows and per-customer slices on screen     |

Eager collections still log a loud `console.error` if the server ever truncates them. An on-demand subset without a
limit that matches more rows than one request returns is refused (`SubsetTooLargeError`) instead of being truncated.

**Push-down coverage** (`pushdown.ts`; anything else throws — never a silently wrong window):

- `eq / neq (not eq) / gt / gte / lt / lte / inArray / isNull / not isNull` on a row's own fields, `and`;
- **search**: rows carry a derived `searchText` (exactly the columns the server's `?q=` searches: customers name,
  email, company and owner name, invoices number and customer company), so `ilike(row.searchText, searchPattern(q))`
  is sent as `?q=` and re-evaluated locally to the same rows (LIKE wildcards are kept literal on both sides);
- **sort**: TanStack DB cuts a window by its first sort term and then loads every row _tied_ with the last one, which
  for "sort by plan" means every enterprise customer. Rows therefore carry composite keys `order.<field>` (value + id,
  encoded to compare like SQLite's `ORDER BY field, id`, NULLs and numbers included; compared with
  `stringSort: 'lexical'`), pushed down as `?sort=field,id`: windows are exact and the tie group is one row, which the
  collection answers from the row it already has (no second request). Owner name and customer company sort through
  the server's `owner` / `customerCompany` sort keys;
- **windows**: `limit`, and `offset` as a prefix (TanStack DB counts offsets over local rows, so page _n_ loads the first
  _n_ pages — tables let you page through the first 10,000 matches; flip the sort or filter for the rest);
- **joins**: the joined side loads lazily by key (`?id[in]=…`), e.g. the ledger's invoices and customers, the selected
  customers of the bulk-action summary, the pinned accounts.

**Server aggregates** (TanStack Query on the same QueryClient, `aggregates.ts`): overview KPIs, revenue, signups, the
plan/country/status breakdowns, AR aging and product adoption come from `/metrics/*`; table headers and the sidebar use
`?limit=0&sum=…` with the table's filters. The change feed invalidates exactly the aggregates a change can move
(debounced). Local live-query aggregates remain where the data is bounded: a customer's balance, invoices, payments,
subscriptions; tasks and workload; the selection; the pins.

**Writes** are unchanged (one optimistic transaction, one `POST /api/batch`), with derived fields recomputed on the
optimistic row so it moves in sorted windows at once.

Against `data/big.db` (production build, local API, owner): Overview MRR and the sidebar counts equal the API
(250,000 customers, 1,131,510 invoices), every page is ready in 0.2–1.1 s, the JS heap stays at 12–33 MB while browsing
(62 MB on the deepest customers page, back to ~20 MB once its window is released), no console errors.

### Library behaviours this relies on or works around (TanStack DB 0.12.3, query-db-collection 1.4.2)

- After a direct write (`writeUpsert` from a batch result or SSE) an on-demand query collection **re-reads every
  active subset** of that collection (`writeDirectCache`, query-db-collection `query.ts`; #1826): a changed row can
  enter or leave a window that only the server can refill. So a write costs one batch request plus one re-read per
  window on screen. SSE changes are batched per collection (one write, one re-read), echoes of our own writes and rows
  already stored as-is are skipped, rows nobody holds are not stored (the windows are re-read instead).
- A subset's rows are removed **as soon as nothing holds the subset** (`cleanupQueryInternal`). If a window had already
  shown such a row from local state while its own request was in flight, the ordered loader treats the removal as an
  ordering change and repairs with a **full-source load** — the where-only, unbounded request
  (`OrderedSourceLoader.invalidateSourceOrdering` / `loadFullSource`, db `ordered-source-loader.ts`). This is not
  limited to one table's paging: leaving a customer's page for Billing released their payments while the ledger window
  (which had shown them) was loading, and the ledger came up empty (the guard refused the unbounded payments read).
  Every live query over an on-demand collection is therefore kept alive 10 s after it is left
  (`WINDOW = { gcTime }`, also making "back" instant), and windows are never aborted mid-flight (an aborted
  acquisition counts as failed and is repaired the same way). Collection-level `gcTime` does not help: without
  persistence the subset's rows are deleted on release regardless. An e2e test walks every page and fails on any
  unbounded read of a big table.
- The two above compound: a held query is still an _active_ subset, so it is re-read after every direct write too. A
  3 s hold cut the journey's requests by a fifth but lost the race again (the fallback loaded every overdue invoice,
  2.7 MB); 10 s never did in our runs. There is no "keep the rows, but stop refreshing them" mode.
- Inner joins drive from whichever side has fewer rows _loaded_ (`getActiveAndLazySources`, db `joins.ts`), which can
  be the 250k-row on-demand side; queries that must drive from a small local collection use a left join.
- A cursor boundary on a string sort is only pushed down with `stringSort: 'lexical'` (`canExpressCursorOrder`, db
  `utils/cursor.ts`); on-demand collections set it as their `defaultStringCollation`.

`scripts/journey.mjs` replays the same 18-step signed-in user journey against either branch and reports requests/latency
(`BASE=http://localhost:4173 node scripts/journey.mjs`; `RESET=0 LATENCY=0` against a big database you want to keep).

### The journey on the big database

`data/big.db` (250k customers, ~13M rows), production builds, both clients against their own copy of the database,
`RESET=0 LATENCY=150`, median of 3 runs. Both are correct (same KPIs, counts and rows) and neither reads a big table
whole; the difference is how much they refetch.

| step                                   | Query (main) ms |    req |      kB | DB (this PR) ms |     req |       kB |
| -------------------------------------- | --------------: | -----: | ------: | --------------: | ------: | -------: |
| cold load /                            |            1370 |     16 |      23 |            1369 |      14 |      409 |
| open Customers                         |             294 |      2 |      14 |             368 |       2 |        7 |
| filter status=Active                   |             661 |      2 |      14 |             338 |       2 |        7 |
| search "Labs"                          |             546 |      2 |      13 |             919 |       2 |        7 |
| next page                              |              69 |      2 |       7 |             644 |       1 |       13 |
| sort by MRR                            |             248 |      2 |      14 |             579 |       1 |        7 |
| open customer detail                   |             532 |     11 |      10 |             839 |      14 |       14 |
| edit seats (+5) -> MRR shown           |             380 |      8 |       9 |             228 |      23 |        9 |
| back to Overview (KPIs reflect edit)   |              95 |      7 |       8 |            3919 |       8 |      110 |
| Invoices: filter Overdue               |             332 |      4 |      18 |             590 |       4 |       18 |
| mark first invoice paid                |              53 |      4 |      12 |             771 |      31 |       47 |
| customer: expand invoice               |             424 |     10 |       3 |             900 |      16 |       37 |
| toggle a tag (many-to-many)            |             394 |      3 |       1 |              57 |       3 |        1 |
| Billing (MRR rollup, AR aging, ledger) |             827 |      5 |      11 |            1535 |      13 |       32 |
| Projects -> board                      |             537 |      5 |     287 |             627 |       1 |      381 |
| move a task right                      |              64 |      5 |       4 |              57 |       4 |        9 |
| Team page                              |              79 |      0 |       0 |             251 |       2 |        7 |
| Teams tab: add a member                |             250 |      5 |      13 |             116 |       3 |        0 |
| **total**                              |        **7155** | **93** | **461** |       **14107** | **144** | **1115** |

What it shows, honestly:

- The first version of this branch loaded every table whole and won on the small demo database (4.7 s / 47 requests
  vs 6.2 s / 94: filter, sort, search and page cost zero requests). It was silently wrong at scale (a 10,000-row
  sample). With the big tables on-demand, which correctness requires, it is slower than `main` on the small database
  too (median of 5: 7.4 s / 146 requests / 662 kB vs 5.7 s / 94 / 243 kB) and about 2x slower on the big one.
- **Writes are where it costs.** "Back to Overview" right after a seat edit took 3.9 s: the SSE echoes of the edit
  (customer, subscription, audit, event rows) are direct writes, each makes the customers/invoices/events collections
  re-read every active window (the ones on screen _and_ the ones held for 10 s, e.g. the 1.1 s `?q=labs&limit=50`
  search page), and SQLite serves them one at a time. TanStack Query only refetches what is mounted; held queries
  are inactive there.
- Paging and sorting are slower because TanStack DB counts offsets over local rows: page 2 is `limit=50`, not
  `offset=25&limit=25`.
- Cold load is heavier (409 kB) because the eager small tables (tasks, time entries) load whole; it is still bounded.
- Where the data is bounded (tags, tasks, teams) the DB branch is still the faster and simpler one.

The SQL work that made both usable at this size (indexes, FTS5, the revenue rollup) is in **Scale: millions of rows**
above and is the same on both branches.
