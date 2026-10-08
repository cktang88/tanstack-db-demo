import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useIsFetching, useIsMutating } from '@tanstack/react-query'
import { useSettings } from '../lib/settings'
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

function GlobalStatus() {
  const fetching = useIsFetching()
  const mutating = useIsMutating()
  const loading = useRouterState({ select: (s) => s.status === 'pending' })
  return (
    <div className="flex items-center gap-3 text-xs text-zinc-500" data-testid="global-status">
      {(fetching > 0 || loading) && (
        <span className="flex items-center gap-1.5">
          <Spinner className="size-3" /> syncing {fetching > 0 ? `(${fetching})` : ''}
        </span>
      )}
      {mutating > 0 && <span className="text-amber-600">saving {mutating}…</span>}
    </div>
  )
}

export function Layout() {
  const [settings, setSettings] = useSettings()
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
        <div className="mt-auto mb-14 px-2 text-[11px] leading-relaxed text-zinc-400">
          Data layer: <b>TanStack Query</b>
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
          <GlobalStatus />
          <button
            className="btn-ghost ml-auto"
            aria-label="Toggle theme"
            onClick={() => setSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}
          >
            {settings.theme === 'dark' ? '☀' : '☾'}
          </button>
        </header>
        <main className={cx('mx-auto w-full flex-1 px-6 py-6', settings.compact ? 'max-w-[1600px]' : 'max-w-7xl')}>
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  )
}
