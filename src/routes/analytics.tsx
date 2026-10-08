import { count, eq, sum, useLiveQuery } from '@tanstack/react-db'
import { useState } from 'react'
import { DonutChart, HBarChart, RevenueChart, SignupsChart } from '../components/charts'
import { Card, PageHeader, Segmented } from '../components/ui'
import { customersCollection } from '../db/collections'
import { money, moneyCompact, number, percent, titleCase } from '../lib/format'
import { useRevenue, useSignups } from './overview'

export function AnalyticsPage() {
  const [mode, setMode] = useState<'stacked' | 'grouped'>('stacked')
  const [metric, setMetric] = useState<'mrr' | 'customers'>('mrr')
  const [plan, setPlan] = useState<string>('all')

  // Same breakdowns that used to be three server endpoints — now GROUP BY over
  // the local customers collection, re-filterable instantly (try the plan filter).
  const { data: byCountry } = useLiveQuery({
    query: (q) => {
      let base = q.from({ c: customersCollection })
      if (plan !== 'all') base = base.where(({ c }) => eq(c.plan, plan))
      return base
        .groupBy(({ c }) => c.country)
        .select(({ c }) => ({ key: c.country, mrr: sum(c.mrr), customers: count(c.id) }))
        .orderBy(({ $selected }) => (metric === 'mrr' ? $selected.mrr : $selected.customers), 'desc')
    },
  })
  const { data: byStatus } = useLiveQuery({
    query: (q) => {
      let base = q.from({ c: customersCollection })
      if (plan !== 'all') base = base.where(({ c }) => eq(c.plan, plan))
      return base.groupBy(({ c }) => c.status).select(({ c }) => ({ key: c.status, value: count(c.id) }))
    },
  })
  const { data: byPlan } = useLiveQuery({
    query: (q) =>
      q
        .from({ c: customersCollection })
        .groupBy(({ c }) => c.plan)
        .select(({ c }) => ({ key: c.plan, customers: count(c.id), mrr: sum(c.mrr) }))
        .orderBy(({ $selected }) => $selected.mrr, 'desc'),
  })
  const signups = useSignups(12)
  const revenue = useRevenue(18)
  const totalMrr = byPlan.reduce((s, p) => s + p.mrr, 0)
  const fmt = metric === 'mrr' ? moneyCompact : number

  return (
    <>
      <PageHeader
        title="Analytics"
        description="GROUP BY / SUM / COUNT live queries over local collections — no aggregation endpoints."
        actions={
          <>
            <select className="input w-36" aria-label="Plan filter" value={plan} onChange={(e) => setPlan(e.target.value)}>
              <option value="all">All plans</option>
              {['free', 'starter', 'pro', 'enterprise'].map((p) => (
                <option key={p} value={p}>
                  {titleCase(p)}
                </option>
              ))}
            </select>
            <Segmented
              label="Metric"
              value={metric}
              onChange={setMetric}
              options={[
                { value: 'mrr', label: 'MRR' },
                { value: 'customers', label: 'Customers' },
              ]}
            />
          </>
        }
      />
      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card title={`${metric === 'mrr' ? 'MRR' : 'Customers'} by country`}>
          <HBarChart label="By country" data={byCountry.map((d) => ({ key: d.key, value: d[metric] }))} format={fmt} />
        </Card>
        <Card title="Customers by status">
          <DonutChart label="Status" data={byStatus} height={300} />
        </Card>
      </div>
      <Card
        className="mb-6"
        title="Signups by plan"
        actions={
          <Segmented
            label="Bar layout"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'stacked', label: 'Stacked' },
              { value: 'grouped', label: 'Grouped' },
            ]}
          />
        }
      >
        <SignupsChart data={signups} mode={mode} height={300} />
      </Card>
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card title="Collected revenue (18 months)">
          <RevenueChart data={revenue} />
        </Card>
        <Card title="Plan mix">
          <table className="w-full" data-testid="plan-mix">
            <thead>
              <tr>
                <th className="th">Plan</th>
                <th className="th text-right">Customers</th>
                <th className="th text-right">MRR</th>
                <th className="th text-right">Share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {byPlan.map((p) => (
                <tr key={p.key}>
                  <td className="td">{titleCase(p.key)}</td>
                  <td className="td text-right tabular-nums">{number(p.customers)}</td>
                  <td className="td text-right tabular-nums">{money(p.mrr)}</td>
                  <td className="td text-right tabular-nums">{percent(totalMrr ? p.mrr / totalMrr : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  )
}
