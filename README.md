# Saasly — TanStack fullstack SaaS dashboard

A realistic SaaS admin dashboard (customers, billing, projects/kanban, team, activity, analytics) built to compare
data-layer approaches. This branch (`main`) is the **"classic heavy TanStack Query"** baseline.

| Layer | Tech |
| --- | --- |
| Toolchain | **Vite+** (`vp dev / build / test / lint / fmt / check`) — Vite 8 + Rolldown, Vitest 5, Oxlint, Oxfmt |
| UI | React 19.3 (client components only): `useActionState`, `useFormStatus`, `useOptimistic`, `useTransition`, `useDeferredValue`, `useEffectEvent`, `<Activity>`, `<ViewTransition>`, document `<title>` |
| Data | TanStack Query 5.104 (`queryOptions`, `infiniteQueryOptions`, suspense, `useSuspenseQueries`, `useQueries`+`combine`, `keepPreviousData`, `select`, polling, `queryClient.query()` prefetching, cache-based optimistic updates + rollback, `useMutationState`, mutation `scope`, devtools) |
| Routing | TanStack Router (typed params, validated search params as table state, loaders, intent preloading, `stripSearchParams`) |
| Tables | TanStack Table v9 (`tableFeatures`, server-side/manual pagination + sorting, row selection, column visibility, `table.FlexRender`) |
| Charts | TanStack Charts 1.0 (`defineChart`, line/area, stacked/grouped bars, donut via `polar`, crosshair + tooltips) |
| Server | Node + Hono + **Effect 4** (services/layers, typed errors, `Schema` validation, `ManagedRuntime`) + SQLite (better-sqlite3) |
| Shared | Effect `Schema` definitions used for both server request validation and client form validation (Standard Schema) |
| Tests | Vitest (server API against in-memory SQLite, client components with Testing Library) + Playwright E2E |

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

## API

`GET /api/{customers,invoices,projects,tasks,users,events}` share one list grammar:

```
?page=2&pageSize=25            1-based pagination      ?limit=50&offset=100   raw window
?sort=-mrr,name                multi-column sort       ?q=acme                full-text-ish search
?status=active,trial           IN shorthand            ?mrr[gte]=1000&ownerId[isNull]   explicit operators
```

Plus CRUD (`POST/PATCH/DELETE`), `/api/events/feed` (cursor pagination), `/api/events/stream` (SSE change feed),
`/api/metrics/*` (SQL aggregations), `/api/dev/{chaos,reset}`.
