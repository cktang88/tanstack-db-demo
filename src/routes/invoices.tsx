import { and, eq, gte, ilike, inArray, lte, useLiveQuery } from '@tanstack/react-db'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { INVOICE_STATUSES } from '../../shared/domain'
import { DataTable, type ServerFeatures } from '../components/DataTable'
import { Badge, ChipFilter, PageHeader, Stat } from '../components/ui'
import { markInvoicePaid } from '../db/actions'
import { listTotalQuery } from '../db/aggregates'
import { INVOICE_SORTS, invoicesCollection, type InvoiceSort } from '../db/collections'
import { usePageAnchor, usePagedWindow, WINDOW } from '../db/hooks'
import { MAX_ROWS, searchPattern } from '../db/pushdown'
import { date, money, number } from '../lib/format'
import { useDebouncedParam } from '../lib/hooks'
import { formatSort, parseSort, type InvoiceListParams } from '../lib/search'
import { useCan } from '../lib/auth'
import { toast } from '../lib/toast'
import { invoicesRoute } from '../router'

const endOfDay = (d: string) => `${d}T23:59:59.999Z`
const invoiceFilters = (s: InvoiceListParams) => (i: any) =>
  [
    s.status ? inArray(i.status, s.status) : undefined,
    s.customerId ? eq(i.customerId, s.customerId) : undefined,
    s.issuedFrom ? gte(i.issuedAt, s.issuedFrom) : undefined,
    s.issuedTo ? lte(i.issuedAt, endOfDay(s.issuedTo)) : undefined,
    // invoice number or customer company, like the server's ?q= (see searchText in collections.ts)
    s.q ? ilike(i.searchText, searchPattern(s.q)) : undefined,
  ].filter((p) => p !== undefined)
const allOf = (parts: any[]) => (parts.length === 1 ? parts[0] : and(parts[0], parts[1], ...parts.slice(2)))
const hasFilters = (s: InvoiceListParams) => !!(s.status || s.customerId || s.issuedFrom || s.issuedTo || s.q)

/** The same filters in the REST grammar, for the server totals. */
const listParams = (s: InvoiceListParams) => ({
  q: s.q,
  status: s.status,
  customerId: s.customerId,
  'issuedAt[gte]': s.issuedFrom,
  'issuedAt[lte]': s.issuedTo && endOfDay(s.issuedTo),
})

const isSortable = (id: string): id is InvoiceSort => Object.hasOwn(INVOICE_SORTS, id)

function useInvoiceRows(s: InvoiceListParams) {
  const [sort] = parseSort(s.sort)
  const field: InvoiceSort = sort && isSortable(sort.id) ? sort.id : 'issuedAt'
  const direction = sort?.desc === false ? 'asc' : 'desc'
  // one on-demand window; the customer's company comes with each invoice (customerCompany)
  const anchor = usePageAnchor((s.page - 1) * s.pageSize, s.pageSize)
  const page = useLiveQuery({
    ...WINDOW,
    query: (q) => {
      const base = q.from({ i: invoicesCollection })
      return (hasFilters(s) ? base.where(({ i }) => allOf(invoiceFilters(s)(i))) : base)
        .orderBy(({ i }) => i.order[field], direction)
        .limit(s.pageSize)
        .offset(anchor)
    },
  })
  // count and amount of every match: a server aggregate
  const totals = useQuery(listTotalQuery('invoices', listParams(s), 'amount'))
  const { rows, isPlaceholder } = usePagedWindow(page, (s.page - 1) * s.pageSize, s.pageSize)
  return {
    rows,
    isPlaceholder,
    isFetching: totals.isFetching || page.isLoading,
    total: totals.data?.total ?? 0,
    amount: totals.data?.sums.amount ?? 0,
  }
}

type Row = ReturnType<typeof useInvoiceRows>['rows'][number]
const col = createColumnHelper<ServerFeatures, Row>()
const columns = col.columns([
  col.accessor('number', { header: 'Invoice', cell: (i) => <span className="font-mono text-xs">{i.getValue()}</span> }),
  col.accessor('customerCompany', {
    id: 'company',
    header: 'Customer',
    cell: (i) => (
      <Link to="/customers/$customerId" params={{ customerId: i.row.original.customerId }} className="hover:text-brand-600">
        {i.getValue()}
      </Link>
    ),
  }),
  col.accessor('status', {
    header: 'Status',
    cell: (i) => (
      <span className="flex items-center gap-2">
        <Badge value={i.getValue()} />
        {i.row.original.$hasPendingWrites && <span className="text-xs text-amber-600">saving…</span>}
      </span>
    ),
  }),
  col.accessor('issuedAt', { header: 'Issued', cell: (i) => date(i.getValue()) }),
  col.accessor('dueAt', { header: 'Due', cell: (i) => date(i.getValue()) }),
  col.accessor('paidAt', { header: 'Paid', cell: (i) => date(i.getValue()) }),
  col.accessor('amount', { header: 'Amount', cell: (i) => <span className="tabular-nums">{money(i.getValue())}</span> }),
  col.display({
    id: 'actions',
    header: '',
    cell: ({ row }) => <MarkPaid invoice={row.original} />,
  }),
])

function MarkPaid({ invoice }: { invoice: Row }) {
  const canPay = useCan().can('billing:write')
  if (!canPay || (invoice.status !== 'open' && invoice.status !== 'overdue')) return null
  return (
    <button
      className="btn-ghost px-2 py-0.5 text-xs"
      onClick={() =>
        markInvoicePaid({ invoiceId: invoice.id, number: invoice.number, customerId: invoice.customerId })
          .when('settled')
          .catch((e: Error) => toast.error('Could not mark invoice paid — rolled back', e.message))
      }
    >
      Mark paid
    </button>
  )
}

export function InvoicesPage() {
  const search = invoicesRoute.useSearch()
  const navigate = useNavigate({ from: '/invoices' })
  const { rows, total, amount, isPlaceholder, isFetching } = useInvoiceRows(search)
  const setSearch = (patch: Partial<InvoiceListParams>, resetPage = true) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, ...(resetPage ? { page: 1 } : {}) }), replace: true })

  return (
    <>
      <PageHeader
        title="Invoices"
        description="An on-demand window of invoices: filters, search and sort are pushed down to the API; totals are a server aggregate."
      />
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Stat label="Matching invoices" value={number(total)} testId="invoice-count" />
        <Stat
          label="Total of all matches"
          value={money(amount)}
          hint="Server total over every matching row"
          testId="invoice-total"
        />
        <Stat
          label="Rows held locally"
          value={number(rows.length)}
          hint="Only this window — the company comes with each invoice"
        />
      </div>
      <DataTable
        testId="invoices-table"
        columns={columns}
        data={rows}
        rowCount={total}
        maxRows={MAX_ROWS}
        isPlaceholder={isPlaceholder}
        isFetching={isFetching}
        pagination={{ pageIndex: search.page - 1, pageSize: search.pageSize }}
        onPaginationChange={(p) => setSearch({ page: p.pageIndex + 1, pageSize: p.pageSize }, p.pageSize !== search.pageSize)}
        sorting={parseSort(search.sort)}
        onSortingChange={(s) => setSearch({ sort: formatSort(s) })}
        toolbar={
          <div className="flex flex-wrap items-center gap-3">
            <SearchBox value={search.q} onChange={(q) => setSearch({ q })} />
            <ChipFilter
              label="Status"
              options={INVOICE_STATUSES}
              value={search.status ?? []}
              onChange={(status) => setSearch({ status: status.length ? status : undefined })}
            />
            <label className="flex items-center gap-1 text-xs text-zinc-500">
              From
              <input
                type="date"
                className="input w-36"
                value={search.issuedFrom ?? ''}
                onChange={(e) => setSearch({ issuedFrom: e.target.value || undefined })}
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-zinc-500">
              To
              <input
                type="date"
                className="input w-36"
                value={search.issuedTo ?? ''}
                onChange={(e) => setSearch({ issuedTo: e.target.value || undefined })}
              />
            </label>
          </div>
        }
      />
    </>
  )
}

/** Search pushes `?q=` down to the server: wait for a pause in typing (250ms) first. */
function SearchBox({ value, onChange }: { value?: string; onChange: (q?: string) => void }) {
  const [text, setText] = useDebouncedParam(value, onChange)
  return (
    <input
      className="input w-56"
      placeholder="Invoice # or company"
      value={text}
      onChange={(e) => setText(e.target.value)}
      aria-label="Search invoices"
    />
  )
}
