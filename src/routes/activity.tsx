import { useLiveInfiniteQuery } from '@tanstack/react-db'
import { Link } from '@tanstack/react-router'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { Avatar, Badge, Card, PageHeader, Segmented, Spinner } from '../components/ui'
import { eventsByCategory, eventsCollection, type EventCategory } from '../db/collections'
import { useUsersById } from '../db/hooks'
import { date, relative } from '../lib/format'

const PAGE_SIZE = 30

const TYPES = [
  { value: '', label: 'All' },
  { value: 'customer', label: 'Customers' },
  { value: 'invoice', label: 'Invoices' },
  { value: 'task', label: 'Tasks' },
] as const

export function ActivityPage() {
  const [type, setType] = useState<string>('')
  return (
    <>
      <PageHeader
        title="Activity"
        description="On-demand collection: each window's filter/order/limit/offset is pushed to the API; new events stream in over SSE."
        actions={<Segmented label="Event type" value={type} options={TYPES} onChange={setType} />}
      />
      <Feed type={type} />
    </>
  )
}

function Feed({ type }: { type: string }) {
  // Infinite window over an on-demand collection; every page is pushed down:
  //   GET /api/events?category[eq]=invoice&sort=-id&limit=31   (then &offset=…)
  // The category filter is a *scoped collection* (see eventsByCategory) rather than a `where`.
  const source = type ? eventsByCategory[type as EventCategory] : eventsCollection
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useLiveInfiniteQuery(
    (q) =>
      q
        .from({ e: source })
        // ids are monotonic: one unique sort key -> exact windows and tiny tie-group requests
        .orderBy(({ e }) => e.id, 'desc'),
    { pageSize: PAGE_SIZE, queryKey: ['activity-feed', type] },
  )
  const users = useUsersById()

  const sentinel = useRef<HTMLDivElement>(null)
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

  const groups = useMemo(() => {
    const m = new Map<string, typeof data>()
    for (const e of data) {
      const d = e.createdAt.slice(0, 10)
      m.set(d, [...(m.get(d) ?? []), e])
    }
    return [...m]
  }, [data])

  return (
    <Card>
      {isLoading && (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      )}
      <ol className="space-y-6" data-testid="activity-feed">
        {groups.map(([day, events]) => (
          <li key={day}>
            <div className="mb-2 text-xs font-semibold text-zinc-500 uppercase">{date(day)}</div>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {events.map((e) => {
                const actor = e.actorId ? users.get(e.actorId) : undefined
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
