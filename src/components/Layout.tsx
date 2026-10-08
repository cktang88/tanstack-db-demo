import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { useIsFetching, useIsMutating, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { Permission } from '../../shared/domain'
import { useCan, useLogout } from '../lib/auth'
import { relative } from '../lib/format'
import { useMarkNotificationsRead } from '../lib/mutations'
import { notificationsQuery } from '../lib/queries'
import { useSettings } from '../lib/settings'
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

function useNav() {
  const { can } = useCan()
  return NAV.filter((n) => !n.permission || can(n.permission))
}

function Notifications() {
  const { data = [] } = useQuery(notificationsQuery())
  const mark = useMarkNotificationsRead()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])
  const unread = data.filter((n) => !n.readAt).length
  return (
    <div className="relative" ref={ref}>
      <button className="btn-ghost relative" aria-label={`Notifications (${unread} unread)`} onClick={() => setOpen((o) => !o)}>
        🔔
        {unread > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 rounded-full bg-red-600 px-1 text-[10px] text-white"
            data-testid="unread-count"
          >
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div className="card absolute right-0 z-30 mt-2 w-80 p-0 shadow-xl" data-testid="notifications">
          <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2 text-sm font-medium dark:border-zinc-800">
            Notifications
            <button className="text-xs text-brand-600" onClick={() => mark.mutate('all')} disabled={!unread}>
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
                      onClick={() => mark.mutate(n.id)}
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
  const nav = useNav()
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
        <div className="mt-auto mb-14 px-2 text-[11px] leading-relaxed text-zinc-400">
          Data layer: <b>TanStack Query</b>
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
          <GlobalStatus />
          <div className="ml-auto flex items-center gap-2">
            <button
              className="btn-ghost"
              aria-label="Toggle theme"
              onClick={() => setSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}
            >
              {settings.theme === 'dark' ? '☀' : '☾'}
            </button>
            <Notifications />
            <UserMenu />
          </div>
        </header>
        <main className={cx('mx-auto w-full flex-1 px-6 py-6', settings.compact ? 'max-w-[1600px]' : 'max-w-7xl')}>
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  )
}
