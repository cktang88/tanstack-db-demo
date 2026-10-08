import { useQuery, useSuspenseQueries } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Suspense, useMemo, useState, useTransition } from 'react'
import type { Customer } from '../../shared/domain'
import { RevenueChart, SignupsChart, DonutChart } from '../components/charts'
import { Avatar, Badge, Card, PageHeader, Segmented, Skeleton, Spinner, Stat } from '../components/ui'
import { money, moneyCompact, number, percent, relative } from '../lib/format'
import { sortPins, usePins } from '../lib/pins'
import {
  breakdownQuery,
  customersByIdsQuery,
  customersListQuery,
  distinctIds,
  invoicesListQuery,
  openInvoiceTotalsQuery,
  overviewQuery,
  recentActivityQuery,
  revenueQuery,
  signupsQuery,
  usersQuery,
} from '../lib/queries'

export function OverviewPage() {
  const [months, setMonths] = useState<6 | 12 | 18>(12)
  const [isPending, startTransition] = useTransition()

  // Parallel suspense queries: one waterfall-free round trip per widget
  const [{ data: kpi }, { data: revenue }] = useSuspenseQueries({
    queries: [overviewQuery(), revenueQuery(months)],
  })

  const last = revenue.at(-1)?.revenue ?? 0
  const prev = revenue.at(-2)?.revenue ?? 0
  const growth = prev ? (last - prev) / prev : 0

  return (
    <>
      <PageHeader title="Overview" description="Your SaaS business at a glance." />
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
            <>
              {isPending && <Spinner />}
              <Segmented
                label="Revenue range"
                value={String(months) as '6' | '12' | '18'}
                options={[
                  { value: '6', label: '6m' },
                  { value: '12', label: '12m' },
                  { value: '18', label: '18m' },
                ]}
                onChange={(v) => startTransition(() => setMonths(Number(v) as 6 | 12 | 18))}
              />
            </>
          }
        >
          <RevenueChart data={revenue} />
        </Card>
        <Card title="MRR by plan">
          <Suspense fallback={<Skeleton className="h-60" />}>
            <PlanDonut />
          </Suspense>
        </Card>
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="New customers">
          <Suspense fallback={<Skeleton className="h-64" />}>
            <Signups />
          </Suspense>
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
  const [{ data }] = useSuspenseQueries({ queries: [breakdownQuery('plan')] })
  return <DonutChart label="Plan" data={data.map((d) => ({ key: d.key, value: d.mrr }))} format={moneyCompact} />
}

function Signups() {
  const [{ data }] = useSuspenseQueries({ queries: [signupsQuery(12)] })
  return <SignupsChart data={data} />
}

function RecentActivity() {
  const { data = [], isPending } = useQuery(recentActivityQuery())
  const { data: users = [] } = useQuery(usersQuery())
  if (isPending) return <Skeleton className="h-60" />
  return (
    <ul className="space-y-3" data-testid="recent-activity">
      {data.map((e) => {
        const u = users.find((x) => x.id === e.actorId)
        return (
          <li key={e.id} className="flex items-start gap-2 text-sm">
            {u && <Avatar name={u.name} color={u.avatarColor} size={22} />}
            <div className="min-w-0">
              <div className="truncate">{e.message}</div>
              <div className="text-xs text-zinc-400">{relative(e.createdAt)}</div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function TopCustomers() {
  const { data, isPending } = useQuery(customersListQuery({ page: 1, pageSize: 6, sort: '-mrr', status: ['active'] }))
  if (isPending) return <Skeleton className="h-48" />
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" data-testid="top-customers">
      {data?.data.map((c) => (
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

const NO_CUSTOMERS = new Map<number, Customer>()
const NO_TOTALS = new Map<number, number>()

function OverdueInvoices() {
  const { data, isPending } = useQuery(invoicesListQuery({ page: 1, pageSize: 6, sort: 'dueAt', status: ['overdue'] }))
  // the invoices only carry customer ids: one batched lookup for their companies
  const ids = useMemo(() => distinctIds(data?.data.map((i) => i.customerId) ?? []), [data])
  const { data: customers = NO_CUSTOMERS } = useQuery(customersByIdsQuery(ids))
  if (isPending) return <Skeleton className="h-48" />
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" data-testid="overdue-invoices">
      {data?.data.map((i) => (
        <li key={i.id} className="flex items-center justify-between gap-3 py-2 text-sm">
          <Link
            to="/customers/$customerId"
            params={{ customerId: i.customerId }}
            className="min-w-0 flex-1 truncate hover:underline"
          >
            <span className="font-mono text-xs">{i.number}</span>{' '}
            <span className="text-zinc-500">· {customers.get(i.customerId)?.company ?? '…'}</span>
          </Link>
          <span className="text-xs text-zinc-500">due {relative(i.dueAt)}</span>
          <span className="w-24 text-right tabular-nums">{money(i.amount)}</span>
        </li>
      ))}
    </ul>
  )
}

function PinnedAccounts() {
  // localStorage pins + ONE batched customer lookup + ONE query of their open invoices
  const pins = usePins()
  const ids = useMemo(() => distinctIds(pins.map((p) => p.id)), [pins])
  const { data: customers = NO_CUSTOMERS } = useQuery(customersByIdsQuery(ids))
  const { data: open = NO_TOTALS } = useQuery(openInvoiceTotalsQuery(ids))
  // archived customers are no longer served, so their pins drop out (an inner join)
  const data = sortPins(pins).flatMap((p) => {
    const c = customers.get(p.id)
    return c ? [{ ...c, outstanding: open.get(c.id) ?? 0 }] : []
  })
  return (
    <Card
      title={`Pinned accounts (${data.length})`}
      actions={<span className="text-xs text-zinc-400">localStorage ⨝ server data</span>}
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
                  {money(c.mrr)} MRR · {money(c.outstanding)} open invoices
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
