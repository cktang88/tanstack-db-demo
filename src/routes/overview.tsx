import { and, eq, inArray, sum, useLiveQuery } from '@tanstack/react-db'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { DonutChart, RevenueChart, SignupsChart } from '../components/charts'
import { Avatar, Badge, Card, PageHeader, Segmented, Stat } from '../components/ui'
import { breakdownQuery, overviewQuery, revenueQuery, signupsQuery } from '../db/aggregates'
import { customersCollection, eventsCollection, invoicesCollection, pinsCollection, usersCollection } from '../db/collections'
import { WINDOW } from '../db/hooks'
import { money, moneyCompact, number, percent, relative } from '../lib/format'

/**
 * KPIs span every customer and invoice: a server aggregate (/metrics/overview),
 * re-read when the change feed reports a write that moves it (see live.ts).
 */
export function useKpis() {
  return useSuspenseQuery(overviewQuery()).data
}

/** Monthly collected revenue (complete months only) from the server's revenue rollup. */
export function useRevenue(months: number) {
  return useQuery(revenueQuery(months)).data ?? []
}

/** New signups per month by plan (server aggregate). */
export function useSignups(months: number) {
  return useQuery(signupsQuery(months)).data ?? []
}

export function OverviewPage() {
  const [months, setMonths] = useState<6 | 12 | 18>(12)
  const kpi = useKpis()
  const revenue = useRevenue(months)
  const last = revenue.at(-1)?.revenue ?? 0
  const prev = revenue.at(-2)?.revenue ?? 0
  const growth = prev ? (last - prev) / prev : 0

  return (
    <>
      <PageHeader
        title="Overview"
        description="KPIs and charts are server aggregates kept fresh by the change feed; the lists are on-demand windows of the local database."
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="MRR" value={money(kpi.mrr)} hint={`ARR ${moneyCompact(kpi.arr)}`} testId="kpi-mrr" />
        <Stat
          label="Active customers"
          value={number(kpi.activeCustomers)}
          hint={`${number(kpi.trialCustomers)} trials · ${number(kpi.churnedCustomers)} churned`}
          testId="kpi-active"
        />
        <Stat
          label="Outstanding"
          value={money(kpi.outstanding)}
          hint={`${number(kpi.overdueCount)} overdue invoices`}
          testId="kpi-outstanding"
        />
        <Stat label="ARPA" value={money(kpi.arpa)} hint={`${number(kpi.openTasks)} open tasks`} testId="kpi-arpa" />
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title={
            <span className="flex items-center gap-2">
              Collected revenue
              <span className={growth >= 0 ? 'text-xs text-emerald-600' : 'text-xs text-red-600'}>
                {growth >= 0 ? '▲' : '▼'} {percent(Math.abs(growth))} MoM
              </span>
            </span>
          }
          actions={
            // the previous range stays on screen while the next one loads (placeholder data)
            <Segmented
              label="Revenue range"
              value={String(months) as '6' | '12' | '18'}
              options={[
                { value: '6', label: '6m' },
                { value: '12', label: '12m' },
                { value: '18', label: '18m' },
              ]}
              onChange={(v) => setMonths(Number(v) as 6 | 12 | 18)}
            />
          }
        >
          <RevenueChart data={revenue} />
        </Card>
        <Card title="MRR by plan">
          <PlanDonut />
        </Card>
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="New customers">
          <SignupsChart data={useSignups(12)} />
        </Card>
        <Card
          title="Live activity"
          actions={<span className="flex items-center gap-1 text-xs text-emerald-600">● pushed via SSE</span>}
        >
          <RecentActivity />
        </Card>
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card
          title="Top accounts by MRR"
          actions={
            <Link to="/customers" search={{ sort: '-mrr' }} className="text-xs text-brand-600">
              View all
            </Link>
          }
        >
          <TopCustomers />
        </Card>
        <Card
          title="Overdue invoices"
          actions={
            <Link to="/invoices" search={{ status: ['overdue'] }} className="text-xs text-brand-600">
              View all
            </Link>
          }
        >
          <OverdueInvoices />
        </Card>
      </div>
      <PinnedAccounts />
    </>
  )
}

function PlanDonut() {
  // active MRR per plan, over every customer (server aggregate)
  const { data = [] } = useQuery(breakdownQuery('plan'))
  return <DonutChart label="Plan" data={data.map((d) => ({ key: d.key, value: d.mrr }))} format={moneyCompact} />
}

function RecentActivity() {
  // On-demand collection: this pushes `?sort=-id&limit=8` to the API.
  // New events arrive over SSE and are written straight into the collection.
  const { data, isLoading } = useLiveQuery({
    ...WINDOW,
    query: (q) =>
      q
        .from({ e: eventsCollection })
        .join({ u: usersCollection }, ({ e, u }) => eq(e.actorId, u.id))
        // ids are monotonic, so a single unique sort key keeps pushed-down windows exact & cheap
        .orderBy(({ e }) => e.id, 'desc')
        .limit(8),
  })
  if (isLoading) return <div className="h-60 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800" />
  return (
    <ul className="space-y-3" data-testid="recent-activity">
      {data.map(({ e, u }) => (
        <li key={e.id} className="flex items-start gap-2 text-sm">
          {u && <Avatar name={u.name} color={u.avatarColor} size={22} />}
          <div className="min-w-0">
            <div className="truncate">{e.message}</div>
            <div className="text-xs text-zinc-400">{relative(e.createdAt)}</div>
          </div>
        </li>
      ))}
    </ul>
  )
}

function TopCustomers() {
  // on-demand window: ?status[eq]=active&sort=-mrr,-id&limit=6
  const { data } = useLiveQuery({
    ...WINDOW,
    query: (q) =>
      q
        .from({ c: customersCollection })
        .where(({ c }) => eq(c.status, 'active'))
        .orderBy(({ c }) => c.order.mrr, 'desc')
        .limit(6),
  })
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" data-testid="top-customers">
      {data.map((c) => (
        <li key={c.id} className="flex items-center justify-between py-2 text-sm">
          <Link to="/customers/$customerId" params={{ customerId: c.id }} className="font-medium hover:underline">
            {c.company}
          </Link>
          <span className="flex items-center gap-3">
            <Badge value={c.plan} />
            <span className="w-24 text-right tabular-nums">{money(c.mrr)}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function OverdueInvoices() {
  // on-demand window: ?status[eq]=overdue&sort=dueAt,id&limit=6 — each invoice carries its company
  const { data } = useLiveQuery({
    ...WINDOW,
    query: (q) =>
      q
        .from({ i: invoicesCollection })
        .where(({ i }) => eq(i.status, 'overdue'))
        .orderBy(({ i }) => i.order.dueAt)
        .limit(6)
        .select(({ i }) => ({
          id: i.id,
          number: i.number,
          dueAt: i.dueAt,
          amount: i.amount,
          customerId: i.customerId,
          company: i.customerCompany,
        })),
  })
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" data-testid="overdue-invoices">
      {data.map((i) => (
        <li key={i.id} className="flex items-center justify-between gap-3 py-2 text-sm">
          <Link
            to="/customers/$customerId"
            params={{ customerId: i.customerId }}
            className="min-w-0 flex-1 truncate hover:underline"
          >
            <span className="font-mono text-xs">{i.number}</span> <span className="text-zinc-500">· {i.company}</span>
          </Link>
          <span className="text-xs text-zinc-500">due {relative(i.dueAt)}</span>
          <span className="w-24 text-right tabular-nums">{money(i.amount)}</span>
        </li>
      ))}
    </ul>
  )
}

function PinnedAccounts() {
  const { data: pins } = useLiveQuery({ query: (q) => q.from({ p: pinsCollection }) })
  const ids = pins.map((p) => p.id)
  // Pins live in localStorage; only the pinned customers and their open invoices are loaded
  // (?id[in]=… and ?customerId[in]=…&status[in]=open,overdue), then joined with the pins locally.
  const { data = [] } = useLiveQuery({
    query: (q) => {
      if (!ids.length) return undefined
      const openByCustomer = q
        .from({ i: invoicesCollection })
        .where(({ i }) => and(inArray(i.customerId, ids), inArray(i.status, ['open', 'overdue'])))
        .groupBy(({ i }) => i.customerId)
        .select(({ i }) => ({ customerId: i.customerId, outstanding: sum(i.amount) }))
      return q
        .from({ c: customersCollection })
        .where(({ c }) => inArray(c.id, ids))
        .innerJoin({ p: pinsCollection }, ({ c, p }) => eq(c.id, p.id))
        .leftJoin({ o: openByCustomer }, ({ c, o }) => eq(c.id, o.customerId))
        .orderBy(({ p }) => p.pinnedAt, 'desc')
        .select(({ c, o, p }) => ({
          id: c.id,
          company: c.company,
          mrr: c.mrr,
          status: c.status,
          outstanding: o?.outstanding,
          pinnedAt: p.pinnedAt,
        }))
    },
  })
  return (
    <Card
      title={`Pinned accounts (${data.length})`}
      actions={<span className="text-xs text-zinc-400">localStorage ⨝ on-demand server rows</span>}
    >
      {data.length === 0 ? (
        <p className="text-sm text-zinc-500">
          Pin customers from their detail page — pins are stored in localStorage and synced across tabs.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="pinned-accounts">
          {data.map((c) => (
            <li key={c.id} className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              <Link to="/customers/$customerId" params={{ customerId: c.id }} className="font-medium hover:underline">
                {c.company}
              </Link>
              <div className="mt-1 flex items-center justify-between text-xs text-zinc-500">
                <Badge value={c.status} />
                <span>
                  {money(c.mrr)} MRR · {money(c.outstanding ?? 0)} open invoices
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
