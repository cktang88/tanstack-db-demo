import { useQuery, useSuspenseInfiniteQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useEffectEvent, useMemo, useRef, useState, useTransition } from 'react'
import type { User } from '../../shared/domain'
import { Avatar, Badge, Card, PageHeader, Segmented, Spinner } from '../components/ui'
import { date, localToday, relative } from '../lib/format'
import { activityFeedQuery, usersQuery } from '../lib/queries'

const TYPES = [
  { value: '', label: 'All' },
  { value: 'customer', label: 'Customers' },
  { value: 'invoice', label: 'Invoices' },
  { value: 'task', label: 'Tasks' },
] as const

export function ActivityPage() {
  const [type, setType] = useState<string>('')
  const [isPending, startTransition] = useTransition()
  return (
    <>
      <PageHeader
        title="Activity"
        description="Infinite, cursor-paginated audit log (useSuspenseInfiniteQuery + IntersectionObserver)."
        actions={
          <>
            {isPending && <Spinner />}
            <Segmented label="Event type" value={type} options={TYPES} onChange={(v) => startTransition(() => setType(v))} />
          </>
        }
      />
      <Feed type={type || undefined} />
    </>
  )
}

function Feed({ type }: { type?: string }) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useSuspenseInfiniteQuery({
    ...activityFeedQuery(type),
    select: (d) => d.pages.flatMap((p) => p.data),
  })
  const { data: users = [] } = useQuery(usersQuery())
  const byId = useMemo(() => new Map<number, User>(users.map((u) => [u.id, u])), [users])

  const sentinel = useRef<HTMLDivElement>(null)
  // useEffectEvent: read the latest flags without re-subscribing the observer
  const onVisible = useEffectEvent(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  })
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver((entries) => entries[0]?.isIntersecting && onVisible(), { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // group by the user's local calendar day
  const groups = useMemo(() => {
    const m = new Map<string, typeof data>()
    for (const e of data) {
      const d = localToday(new Date(e.createdAt))
      m.set(d, [...(m.get(d) ?? []), e])
    }
    return [...m]
  }, [data])

  return (
    <Card>
      <ol className="space-y-6" data-testid="activity-feed">
        {groups.map(([day, events]) => (
          <li key={day}>
            <div className="mb-2 text-xs font-semibold text-zinc-500 uppercase">{date(day)}</div>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {events.map((e) => {
                const actor = e.actorId ? byId.get(e.actorId) : undefined
                return (
                  <li key={e.id} className="flex items-center gap-3 py-2" data-testid="activity-item">
                    {actor ? <Avatar name={actor.name} color={actor.avatarColor} size={24} /> : <span className="size-6" />}
                    <div className="min-w-0 flex-1 text-sm">
                      <span className="font-medium">{actor?.name ?? 'System'}</span>{' '}
                      <span className="text-zinc-600 dark:text-zinc-300">{e.message}</span>
                      {e.customerId && (
                        <>
                          {' '}
                          <Link
                            to="/customers/$customerId"
                            params={{ customerId: e.customerId }}
                            className="text-brand-600 hover:underline"
                          >
                            view
                          </Link>
                        </>
                      )}
                    </div>
                    <Badge value={e.type.split('.')[0]!} />
                    <time className="w-24 text-right text-xs text-zinc-400" dateTime={e.createdAt}>
                      {relative(e.createdAt)}
                    </time>
                  </li>
                )
              })}
            </ul>
          </li>
        ))}
      </ol>
      <div ref={sentinel} className="flex justify-center py-4 text-sm text-zinc-500">
        {isFetchingNextPage ? <Spinner /> : hasNextPage ? 'Scroll for more' : 'You reached the beginning of time.'}
      </div>
    </Card>
  )
}
