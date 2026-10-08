import { useSuspenseQueries } from '@tanstack/react-query'
import { useDeferredValue, useState } from 'react'
import { PLANS, type Plan } from '../../shared/domain'
import { DonutChart, HBarChart, RevenueChart, SignupsChart } from '../components/charts'
import { Card, cx, PageHeader, Segmented } from '../components/ui'
import { money, moneyCompact, number, percent, titleCase } from '../lib/format'
import { breakdownQuery, overviewQuery, revenueQuery, signupsQuery } from '../lib/queries'

export function AnalyticsPage() {
  const [mode, setMode] = useState<'stacked' | 'grouped'>('stacked')
  const [metric, setMetric] = useState<'mrr' | 'customers'>('mrr')
  const [plan, setPlan] = useState<Plan | 'all'>('all')
  // Switching plans suspends on a new query key; deferring it keeps the current
  // charts on screen (dimmed) until the filtered breakdowns arrive.
  const shownPlan = useDeferredValue(plan)
  const planFilter = shownPlan === 'all' ? undefined : shownPlan
  // Six server-side aggregation endpoints, fetched in parallel.
  const [{ data: byCountry }, { data: byStatus }, { data: byPlan }, { data: signups }, { data: revenue }, { data: kpi }] =
    useSuspenseQueries({
      queries: [
        breakdownQuery('country', planFilter),
        breakdownQuery('status', planFilter),
        breakdownQuery('plan'),
        signupsQuery(12),
        revenueQuery(18),
        overviewQuery(),
      ],
    })
  const fmt = metric === 'mrr' ? moneyCompact : number

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Breakdowns computed by SQL aggregations on the server."
        actions={
          <>
            <select
              className="input w-36"
              aria-label="Plan filter"
              value={plan}
              onChange={(e) => setPlan(e.target.value as Plan | 'all')}
            >
              <option value="all">All plans</option>
              {PLANS.map((p) => (
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
      <div className={cx('mb-6 grid gap-6 transition-opacity lg:grid-cols-2', plan !== shownPlan && 'opacity-60')}>
        <Card title={`${metric === 'mrr' ? 'MRR' : 'Customers'} by country`}>
          <HBarChart label="By country" data={byCountry.map((d) => ({ key: d.key, value: d[metric] }))} format={fmt} />
        </Card>
        <Card title="Customers by status">
          <DonutChart label="Status" data={byStatus.map((d) => ({ key: d.key, value: d.customers }))} height={300} />
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
                  <td className="td text-right tabular-nums">{percent(kpi.mrr ? p.mrr / kpi.mrr : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  )
}
