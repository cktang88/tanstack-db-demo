import { count, gt, useLiveQuery, useLiveQueryEffect, eq } from '@tanstack/react-db'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import {
  customersCollection,
  invoicesCollection,
  projectsCollection,
  tasksCollection,
  usersCollection,
  type CustomerRow,
} from '../db/collections'
import { usePrefs } from '../db/hooks'
import { money, number } from '../lib/format'
import { toast } from '../lib/toast'
import { cx, Spinner, Toaster } from './ui'

const NAV = [
  { to: '/', label: 'Overview', icon: '◧' },
  { to: '/analytics', label: 'Analytics', icon: '◔' },
  { to: '/customers', label: 'Customers', icon: '◎' },
  { to: '/invoices', label: 'Invoices', icon: '▤' },
  { to: '/projects', label: 'Projects', icon: '▦' },
  { to: '/team', label: 'Team', icon: '◍' },
  { to: '/activity', label: 'Activity', icon: '≋' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
] as const

/** Live row counts of the local database — these are reactive queries too. */
function DbStats() {
  const sizes = [
    ['customers', customersCollection],
    ['invoices', invoicesCollection],
    ['tasks', tasksCollection],
    ['projects', projectsCollection],
    ['users', usersCollection],
  ] as const
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5" data-testid="db-stats">
      {sizes.map(([name, c]) => (
        <CollectionSize key={name} name={name} collection={c} />
      ))}
    </dl>
  )
}

function CollectionSize({ name, collection }: { name: string; collection: unknown }) {
  const { data, isReady } = useLiveQuery({
    query: (q) =>
      q
        .from({ r: collection as typeof tasksCollection })
        .select(({ r }) => ({ n: count(r.id) }))
        .findOne(),
  })
  return (
    <>
      <dt>{name}</dt>
      <dd className="text-right tabular-nums">{isReady ? number(data?.n ?? 0) : <Spinner className="size-2.5" />}</dd>
    </>
  )
}

/** Reactive alerts: fire when rows *enter* a query result, whoever changed them (this tab, another tab, the server). */
function LiveAlerts() {
  useLiveQueryEffect<CustomerRow, number>(
    {
      query: (q) => q.from({ c: customersCollection }).where(({ c }) => eq(c.status, 'churned')),
      skipInitial: true,
      onEnter: ({ value }) => void toast.info(`⚠ ${value.company} churned`, 'Detected by a live query effect'),
    },
    [],
  )
  useLiveQueryEffect<CustomerRow, number>(
    {
      query: (q) => q.from({ c: customersCollection }).where(({ c }) => gt(c.mrr, 2_000_000)),
      skipInitial: true,
      onEnter: ({ value }) => void toast.success(`🎉 ${value.company} is now a $20k+ MRR account`, money(value.mrr)),
    },
    [],
  )
  return null
}

export function Layout() {
  const [prefs] = usePrefs()
  const loading = useRouterState({ select: (s) => s.status === 'pending' })
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-zinc-200 bg-white px-3 py-4 md:flex dark:border-zinc-800 dark:bg-zinc-900">
        <Link to="/" className="mb-6 flex items-center gap-2 px-2 text-lg font-semibold">
          <span className="inline-flex size-7 items-center justify-center rounded-lg bg-brand-600 text-sm text-white">S</span>
          Saasly
        </Link>
        <nav className="flex flex-col gap-0.5" aria-label="Main">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              activeOptions={{ exact: n.to === '/' }}
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
              activeProps={{ className: 'bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-white' }}
            >
              <span className="w-4 text-center opacity-70">{n.icon}</span>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto mb-14 space-y-2 px-2 text-[11px] leading-relaxed text-zinc-400">
          <div>
            Data layer: <b>TanStack DB</b>
          </div>
          <DbStats />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-12 items-center justify-between gap-4 border-b border-zinc-200 bg-white/80 px-6 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
          <nav className="flex gap-3 overflow-x-auto text-sm md:hidden" aria-label="Mobile">
            {NAV.map((n) => (
              <Link key={n.to} to={n.to} activeOptions={{ exact: n.to === '/' }} activeProps={{ className: 'font-semibold' }}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="text-xs text-zinc-500" data-testid="global-status">
            {loading && (
              <span className="flex items-center gap-1.5">
                <Spinner className="size-3" /> loading
              </span>
            )}
          </div>
          <ThemeToggle />
        </header>
        <main className={cx('mx-auto w-full flex-1 px-6 py-6', prefs.compact ? 'max-w-[1600px]' : 'max-w-7xl')}>
          <Outlet />
        </main>
      </div>
      <LiveAlerts />
      <Toaster />
    </div>
  )
}

function ThemeToggle() {
  const [prefs, update] = usePrefs()
  return (
    <button
      className="btn-ghost ml-auto"
      aria-label="Toggle theme"
      onClick={() => update({ theme: prefs.theme === 'dark' ? 'light' : 'dark' })}
    >
      {prefs.theme === 'dark' ? '☀' : '☾'}
    </button>
  )
}
