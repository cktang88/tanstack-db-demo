import { count, eq, gt, isNull, useLiveQuery, useLiveQueryEffect } from '@tanstack/react-db'
import { useEffect, useRef, useState } from 'react'
import type { Permission } from '../../shared/domain'
import { useCan, useLogout } from '../lib/auth'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import {
  notificationsCollection,
  customersCollection,
  invoicesCollection,
  projectsCollection,
  tasksCollection,
  usersCollection,
  type CustomerRow,
} from '../db/collections'
import { markAllNotificationsRead } from '../db/actions'
import { usePrefs } from '../db/hooks'
import { money, number, relative } from '../lib/format'
import { toast } from '../lib/toast'
import { Avatar, Badge, cx, Spinner, Toaster } from './ui'

const NAV: ReadonlyArray<{ to: string; label: string; icon: string; permission?: Permission }> = [
  { to: '/', label: 'Overview', icon: '◧' },
  { to: '/analytics', label: 'Analytics', icon: '◔' },
  { to: '/customers', label: 'Customers', icon: '◎', permission: 'customers:read' },
  { to: '/invoices', label: 'Invoices', icon: '▤', permission: 'billing:read' },
  { to: '/billing', label: 'Billing', icon: '$', permission: 'billing:read' },
  { to: '/products', label: 'Products', icon: '▣', permission: 'products:read' },
  { to: '/projects', label: 'Projects', icon: '▦', permission: 'projects:read' },
  { to: '/team', label: 'Team', icon: '◍', permission: 'team:read' },
  { to: '/activity', label: 'Activity', icon: '≋' },
  { to: '/audit', label: 'Audit log', icon: '⎙', permission: 'audit:read' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
]

function Notifications() {
  // my notifications (server-scoped) as a live collection; unread count is a live aggregate
  const { data } = useLiveQuery({
    query: (q) =>
      q
        .from({ n: notificationsCollection })
        .orderBy(({ n }) => n.createdAt, 'desc')
        .orderBy(({ n }) => n.id, 'desc')
        .limit(30),
  })
  const { data: unread } = useLiveQuery({
    query: (q) =>
      q
        .from({ n: notificationsCollection })
        .where(({ n }) => isNull(n.readAt))
        .select(({ n }) => ({ n: count(n.id) }))
        .findOne(),
  })
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])
  const markAll = () =>
    markAllNotificationsRead()
      .when('settled')
      .catch((e: Error) => toast.error('Could not mark notifications read — restored', e.message))
  const count_ = unread?.n ?? 0
  return (
    <div className="relative" ref={ref}>
      <button className="btn-ghost relative" aria-label={`Notifications (${count_} unread)`} onClick={() => setOpen((o) => !o)}>
        🔔
        {count_ > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 rounded-full bg-red-600 px-1 text-[10px] text-white"
            data-testid="unread-count"
          >
            {count_}
          </span>
        )}
      </button>
      {open && (
        <div className="card absolute right-0 z-30 mt-2 w-80 p-0 shadow-xl" data-testid="notifications">
          <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2 text-sm font-medium dark:border-zinc-800">
            Notifications
            <button className="text-xs text-brand-600" onClick={markAll} disabled={!count_}>
              Mark all read
            </button>
          </div>
          <ul className="max-h-96 divide-y divide-zinc-100 overflow-auto dark:divide-zinc-800">
            {data.map((n) => (
              <li key={n.id} className={cx('px-3 py-2 text-sm', !n.readAt && 'bg-brand-50/50 dark:bg-brand-500/10')}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{n.title}</span>
                  {!n.readAt && (
                    <button
                      className="text-xs text-zinc-400 hover:text-zinc-700"
                      onClick={() =>
                        notificationsCollection
                          .update(n.id, (d) => void (d.readAt = new Date().toISOString()))
                          .when('settled')
                          .catch((e: Error) => toast.error('Could not mark notification read', e.message))
                      }
                      aria-label="Mark read"
                    >
                      ✓
                    </button>
                  )}
                </div>
                <div className="text-xs text-zinc-500">
                  {n.body} · {relative(n.createdAt)}
                </div>
              </li>
            ))}
            {data.length === 0 && <li className="px-3 py-6 text-center text-sm text-zinc-500">Nothing yet</li>}
          </ul>
        </div>
      )}
    </div>
  )
}

function UserMenu() {
  const { me } = useCan()
  const logout = useLogout()
  return (
    <div className="flex items-center gap-2" data-testid="user-menu">
      <Avatar name={me.user.name} color={me.user.avatarColor} size={26} />
      <div className="hidden text-xs leading-tight sm:block">
        <div className="font-medium">{me.user.name}</div>
        <Badge value={me.user.role} />
      </div>
      <button className="btn-ghost text-xs" onClick={() => logout.mutate()}>
        Sign out
      </button>
    </div>
  )
}

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
  const { can } = useCan()
  const nav = NAV.filter((n) => !n.permission || can(n.permission))
  const loading = useRouterState({ select: (s) => s.status === 'pending' })
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-zinc-200 bg-white px-3 py-4 md:flex dark:border-zinc-800 dark:bg-zinc-900">
        <Link to="/" className="mb-6 flex items-center gap-2 px-2 text-lg font-semibold">
          <span className="inline-flex size-7 items-center justify-center rounded-lg bg-brand-600 text-sm text-white">S</span>
          Saasly
        </Link>
        <nav className="flex flex-col gap-0.5" aria-label="Main">
          {nav.map((n) => (
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
            {nav.map((n) => (
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
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <Notifications />
            <UserMenu />
          </div>
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
      className="btn-ghost"
      aria-label="Toggle theme"
      onClick={() => update({ theme: prefs.theme === 'dark' ? 'light' : 'dark' })}
    >
      {prefs.theme === 'dark' ? '☀' : '☾'}
    </button>
  )
}
