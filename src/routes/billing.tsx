import { caseWhen, count, eq, gte, inArray, sum, useLiveQuery } from '@tanstack/react-db'
import { Link } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { useEffect, useMemo, useState } from 'react'
import { PAYMENT_METHODS } from '../../shared/domain'
import { GroupedBars, HBarChart, RevenueChart } from '../components/charts'
import { DataTable, type ServerFeatures } from '../components/DataTable'
import { Badge, Card, ChipFilter, PageHeader, Stat } from '../components/ui'
import { customersCollection, invoicesCollection, mrrSnapshotsCollection, paymentsCollection } from '../db/collections'
import { api } from '../lib/api'
import { useCan } from '../lib/auth'
import { date, money, moneyCompact, month, number } from '../lib/format'
import { toast } from '../lib/toast'

const BUCKETS = ['current', '1-30', '31-60', '60+']
/**
 * Bucket boundaries at UTC midnight. The live query's identity is derived from
 * its IR (captured values included), so a millisecond-precision "now" would
 * rebuild the query on every render.
 */
const daysAgo = (n: number) => {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return new Date(d.getTime() - n * 86_400_000).toISOString()
}

export function BillingPage() {
  const { can } = useCan()
  const [running, setRunning] = useState(false)
  // the job-maintained rollup is a read-only collection; a rebuild streams new rows in over SSE
  const { data: snapshots } = useLiveQuery({ query: (q) => q.from({ s: mrrSnapshotsCollection }).orderBy(({ s }) => s.month) })
  // AR aging computed live from invoices: bucket with caseWhen, then GROUP BY the bucket
  const { data: aging } = useLiveQuery({
    query: (q) => {
      const bucketed = q
        .from({ i: invoicesCollection })
        .where(({ i }) => inArray(i.status, ['open', 'overdue']))
        .select(({ i }) => ({
          id: i.id,
          amount: i.amount,
          bucket: caseWhen(
            gte(i.dueAt, daysAgo(0)),
            'current',
            gte(i.dueAt, daysAgo(30)),
            '1-30',
            gte(i.dueAt, daysAgo(60)),
            '31-60',
            '60+',
          ),
        }))
      return q
        .from({ b: bucketed })
        .groupBy(({ b }) => b.bucket)
        .select(({ b }) => ({ bucket: b.bucket, amount: sum(b.amount), invoices: count(b.id) }))
    },
  })
  const last = snapshots.at(-1)
  const prev = snapshots.at(-2)
  const outstanding = aging.reduce((s, b) => s + b.amount, 0)
  const movement = useMemo(
    () =>
      snapshots.flatMap((s) => [
        { label: month(s.month), series: 'New MRR', value: s.newMrr },
        { label: month(s.month), series: 'Churned MRR', value: -s.churnedMrr },
      ]),
    [snapshots],
  )
  const run = async (job: 'mark-overdue' | 'rebuild-mrr') => {
    setRunning(true)
    try {
      const r = await api.post(`/jobs/${job}`, {})
      toast.success(`${job} done (${JSON.stringify(r)})`)
    } catch (e) {
      toast.error('Job failed', (e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <PageHeader
        title="Billing"
        description="MRR rollup (job-maintained, streamed in), AR aging computed live from invoices, and the append-only payment ledger."
        actions={
          can('billing:write') && (
            <>
              <button className="btn-secondary" disabled={running} onClick={() => void run('mark-overdue')}>
                Run overdue job
              </button>
              <button className="btn-secondary" disabled={running} onClick={() => void run('rebuild-mrr')}>
                Rebuild MRR rollup
              </button>
            </>
          )
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="MRR (snapshot)"
          value={money(last?.mrr ?? 0)}
          hint={`computed ${last ? date(last.computedAt) : '—'}`}
          testId="billing-mrr"
        />
        <Stat
          label="Net new MRR"
          value={money((last?.newMrr ?? 0) - (last?.churnedMrr ?? 0))}
          hint={`+${moneyCompact(last?.newMrr ?? 0)} / −${moneyCompact(last?.churnedMrr ?? 0)}`}
        />
        <Stat
          label="Active customers"
          value={number(last?.activeCustomers ?? 0)}
          hint={`${last?.newCustomers ?? 0} new · ${last?.churnedCustomers ?? 0} churned (vs ${number(prev?.activeCustomers ?? 0)})`}
        />
        <Stat
          label="Accounts receivable"
          value={money(outstanding)}
          hint={`${number(aging.reduce((s, b) => s + b.invoices, 0))} unpaid invoices · before partial payments`}
          testId="billing-ar"
        />
      </div>
      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        <Card title="MRR by month">
          <RevenueChart data={snapshots.map((s) => ({ month: s.month, revenue: s.mrr }))} />
        </Card>
        <Card title="MRR movement">
          <GroupedBars data={movement} label="New vs churned MRR" format={moneyCompact} />
        </Card>
      </div>
      <div className="mb-6 grid gap-6 lg:grid-cols-[1fr_2fr]">
        <Card title="AR aging (live)">
          <HBarChart
            label="Unpaid by days past due"
            height={220}
            format={moneyCompact}
            data={BUCKETS.map((b) => ({ key: b, value: aging.find((a) => a.bucket === b)?.amount ?? 0 }))}
          />
        </Card>
        <PaymentLedger />
      </div>
    </>
  )
}

function usePaymentRows(pageIndex: number, pageSize: number, methods: string[]) {
  // On-demand ledger window (pushed down as sort=-id&limit&offset[&method[in]]) joined with
  // eager invoices + customers locally: no per-row lookups.
  const rows = useLiveQuery({
    query: (q) => {
      const base = q.from({ p: paymentsCollection })
      const page = (methods.length ? base.where(({ p }) => inArray(p.method, methods)) : base)
        .orderBy(({ p }) => p.id, 'desc')
        .limit(pageSize)
        .offset(pageIndex * pageSize)
      return q
        .from({ p: page })
        .leftJoin({ i: invoicesCollection }, ({ p, i }) => eq(p.invoiceId, i.id))
        .leftJoin({ c: customersCollection }, ({ p, c }) => eq(p.customerId, c.id))
        .orderBy(({ p }) => p.id, 'desc')
        .select(({ p, i, c }) => ({ ...p, number: i?.number, company: c?.company }))
    },
  })
  return rows.data
}

type LedgerRow = ReturnType<typeof usePaymentRows>[number]
const col = createColumnHelper<ServerFeatures, LedgerRow>()
const columns = col.columns([
  col.accessor('receivedAt', { header: 'Received', enableSorting: false, cell: (i) => date(i.getValue()) }),
  col.accessor('reference', {
    header: 'Reference',
    enableSorting: false,
    cell: (i) => <span className="font-mono text-xs">{i.getValue()}</span>,
  }),
  col.accessor('number', { header: 'Invoice', enableSorting: false }),
  col.accessor('company', {
    header: 'Customer',
    enableSorting: false,
    cell: (i) =>
      i.getValue() ? (
        <Link to="/customers/$customerId" params={{ customerId: i.row.original.customerId }} className="hover:text-brand-600">
          {i.getValue()}
        </Link>
      ) : (
        <span className="text-zinc-400">archived #{i.row.original.customerId}</span>
      ),
  }),
  col.accessor('method', { header: 'Method', enableSorting: false, cell: (i) => <Badge value={i.getValue()} tone="zinc" /> }),
  col.accessor('amount', {
    header: 'Amount',
    enableSorting: false,
    cell: (i) => <span className="tabular-nums">{money(i.getValue())}</span>,
  }),
])

function PaymentLedger() {
  const [page, setPage] = useState({ pageIndex: 0, pageSize: 10 })
  const [methods, setMethods] = useState<string[]>([])
  const rows = usePaymentRows(page.pageIndex, page.pageSize, methods)
  // total for the pager: a tiny server count (the ledger itself is never loaded in full)
  const [total, setTotal] = useState(0)
  useEffect(() => {
    void api
      .get<{ total: number }>('/payments', { limit: 0, method: methods.length ? methods : undefined })
      .then((r) => setTotal(r.total))
      .catch(() => {})
  }, [methods])
  return (
    <DataTable
      testId="payments-table"
      columns={columns}
      data={rows}
      rowCount={total}
      pagination={page}
      onPaginationChange={setPage}
      sorting={[]}
      onSortingChange={() => {}}
      toolbar={
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">Payment ledger</span>
          <span className="text-xs text-zinc-500">append-only · on-demand window ⨝ invoices ⨝ customers</span>
          <ChipFilter
            label="Method"
            options={PAYMENT_METHODS}
            value={methods as never}
            onChange={(m) => {
              setMethods(m)
              setPage((p) => ({ ...p, pageIndex: 0 }))
            }}
          />
        </div>
      }
    />
  )
}
