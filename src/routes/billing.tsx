import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { PAYMENT_METHODS, type Customer, type Invoice, type Payment } from '../../shared/domain'
import { GroupedBars, HBarChart, RevenueChart } from '../components/charts'
import { DataTable, type ServerFeatures } from '../components/DataTable'
import { Badge, Card, ChipFilter, PageHeader, Stat } from '../components/ui'
import { useCan } from '../lib/auth'
import { date, money, moneyCompact, month, number } from '../lib/format'
import { useRunJob } from '../lib/mutations'
import {
  arAgingQuery,
  customersByIdsQuery,
  distinctIds,
  invoicesByIdsQuery,
  mrrSnapshotsQuery,
  resourcePage,
} from '../lib/queries'

const BUCKETS = ['current', '1-30', '31-60', '60+']

export function BillingPage() {
  const { data: snapshots } = useSuspenseQuery(mrrSnapshotsQuery())
  const { data: aging } = useSuspenseQuery(arAgingQuery())
  const { can } = useCan()
  const job = useRunJob()
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

  return (
    <>
      <PageHeader
        title="Billing"
        description="MRR rollup (mrr_snapshots, rebuilt by a job), AR aging, and the append-only payment ledger."
        actions={
          can('billing:write') && (
            <>
              <button className="btn-secondary" disabled={job.isPending} onClick={() => job.mutate('mark-overdue')}>
                Run overdue job
              </button>
              <button className="btn-secondary" disabled={job.isPending} onClick={() => job.mutate('rebuild-mrr')}>
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
          hint={`${number(aging.reduce((s, b) => s + b.invoices, 0))} unpaid invoices`}
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
        <Card title="AR aging">
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

const col = createColumnHelper<ServerFeatures, Payment>()
const EMPTY: Payment[] = []
const NO_INVOICES = new Map<number, Invoice>()
const NO_CUSTOMERS = new Map<number, Customer>()

function PaymentLedger() {
  const [page, setPage] = useState({ pageIndex: 0, pageSize: 10 })
  const [methods, setMethods] = useState<string[]>([])
  const query = useQuery(
    resourcePage<Payment>('payments', {
      page: page.pageIndex + 1,
      pageSize: page.pageSize,
      sort: '-receivedAt',
      method: methods.length ? methods : undefined,
    }),
  )
  const rows = query.data?.data ?? EMPTY
  // the ledger only has ids: one batched request each for the page's invoices and customers
  const invoiceIds = useMemo(() => distinctIds(rows.map((r) => r.invoiceId)), [rows])
  const customerIds = useMemo(() => distinctIds(rows.map((r) => r.customerId)), [rows])
  const { data: invoices = NO_INVOICES } = useQuery(invoicesByIdsQuery(invoiceIds))
  const customersQuery = useQuery(customersByIdsQuery(customerIds))
  const customers = customersQuery.data ?? NO_CUSTOMERS
  // a row the settled lookup did not return belongs to an archived (no longer served) customer
  const lookedUp = customersQuery.isSuccess && !customersQuery.isPlaceholderData
  const columns = useMemo(
    () =>
      col.columns([
        col.accessor('receivedAt', { header: 'Received', enableSorting: false, cell: (i) => date(i.getValue()) }),
        col.accessor('reference', {
          header: 'Reference',
          enableSorting: false,
          cell: (i) => <span className="font-mono text-xs">{i.getValue()}</span>,
        }),
        col.accessor('invoiceId', {
          header: 'Invoice',
          enableSorting: false,
          cell: (i) => invoices.get(i.getValue())?.number ?? '…',
        }),
        col.accessor('customerId', {
          header: 'Customer',
          enableSorting: false,
          cell: (i) =>
            customers.get(i.getValue()) ? (
              <Link to="/customers/$customerId" params={{ customerId: i.getValue() }} className="hover:text-brand-600">
                {customers.get(i.getValue())!.company}
              </Link>
            ) : (
              <span className="text-zinc-400">{lookedUp ? `archived #${i.getValue()}` : '…'}</span>
            ),
        }),
        col.accessor('method', {
          header: 'Method',
          enableSorting: false,
          cell: (i) => <Badge value={i.getValue()} tone="zinc" />,
        }),
        col.accessor('amount', {
          header: 'Amount',
          enableSorting: false,
          cell: (i) => <span className="tabular-nums">{money(i.getValue())}</span>,
        }),
      ]),
    [invoices, customers, lookedUp],
  )
  return (
    <DataTable
      testId="payments-table"
      columns={columns}
      data={rows}
      rowCount={query.data?.total ?? 0}
      isFetching={query.isFetching}
      isPlaceholder={query.isPlaceholderData}
      pagination={page}
      onPaginationChange={setPage}
      sorting={[]}
      onSortingChange={() => {}}
      toolbar={
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">Payment ledger</span>
          <span className="text-xs text-zinc-500">
            append-only · {invoiceIds.length} invoices, {customerIds.length} customers joined
          </span>
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
