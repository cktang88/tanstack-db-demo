import { and, count, eq, gte, ilike, inArray, lte, or, sum, useLiveQuery, type InitialQueryBuilder } from '@tanstack/react-db'
import { Link, useNavigate } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { INVOICE_STATUSES } from '../../shared/domain'
import { DataTable, type ServerFeatures } from '../components/DataTable'
import { Badge, ChipFilter, PageHeader, Stat } from '../components/ui'
import { markInvoicePaid } from '../db/actions'
import { customersCollection, invoicesCollection } from '../db/collections'
import { date, money, number } from '../lib/format'
import { formatSort, parseSort, type InvoiceListParams } from '../lib/search'
import { useCan } from '../lib/auth'
import { toast } from '../lib/toast'
import { invoicesRoute } from '../router'

const invoiceFilters = (s: InvoiceListParams) => (i: any) =>
  [
    s.status ? inArray(i.status, s.status) : undefined,
    s.customerId ? eq(i.customerId, s.customerId) : undefined,
    s.issuedFrom ? gte(i.issuedAt, s.issuedFrom) : undefined,
    s.issuedTo ? lte(i.issuedAt, `${s.issuedTo}T23:59:59.999Z`) : undefined,
  ].filter((p) => p !== undefined)
const allOf = (parts: any[]) => (parts.length === 1 ? parts[0] : and(parts[0], parts[1], ...parts.slice(2)))
const hasInvoiceFilter = (s: InvoiceListParams) => !!(s.status || s.customerId || s.issuedFrom || s.issuedTo)

/** invoices ⨝ customers, filtered — needed to search or sort by company. */
function joinedThenFiltered(q: InitialQueryBuilder, s: InvoiceListParams) {
  const base = q.from({ i: invoicesCollection }).innerJoin({ c: customersCollection }, ({ i, c }) => eq(i.customerId, c.id))
  if (!hasInvoiceFilter(s) && !s.q) return base
  return base.where(({ i, c }) =>
    allOf([
      ...invoiceFilters(s)(i),
      // search by invoice number OR the joined customer's company
      ...(s.q ? [or(ilike(i.number, `%${s.q}%`), ilike(c.company, `%${s.q}%`))] : []),
    ]),
  )
}

function filteredOnly(q: InitialQueryBuilder, s: InvoiceListParams) {
  const base = q.from({ i: invoicesCollection })
  return hasInvoiceFilter(s) ? base.where(({ i }) => allOf(invoiceFilters(s)(i))) : base
}

const SORTS = new Set(['number', 'company', 'status', 'issuedAt', 'dueAt', 'paidAt', 'amount'])

function useInvoiceRows(s: InvoiceListParams) {
  const [sort] = parseSort(s.sort)
  const field = sort && SORTS.has(sort.id) ? sort.id : 'issuedAt'
  const direction = sort?.desc === false ? 'asc' : 'desc'
  const joinFirst = field === 'company' || !!s.q
  const joined = useLiveQuery({
    query: (q) =>
      joinFirst
        ? joinedThenFiltered(q, s)
            .orderBy(({ i, c }) => (field === 'company' ? c.company : i[field as 'number']), { direction, nulls: 'last' })
            .orderBy(({ i }) => i.id)
            .limit(s.pageSize)
            .offset((s.page - 1) * s.pageSize)
            .select(({ i, c }) => ({ ...i, company: c.company }))
        : undefined,
  })
  // page the invoices first, then join only the 25 visible rows with their customer
  const paged = useLiveQuery({
    query: (q) => {
      if (joinFirst) return undefined
      const page = filteredOnly(q, s)
        .orderBy(({ i }) => i[field as 'number'], { direction, nulls: 'last' })
        .orderBy(({ i }) => i.id)
        .limit(s.pageSize)
        .offset((s.page - 1) * s.pageSize)
      return q
        .from({ i: page })
        .innerJoin({ c: customersCollection }, ({ i, c }) => eq(i.customerId, c.id))
        .orderBy(({ i }) => i[field as 'number'], { direction, nulls: 'last' })
        .orderBy(({ i }) => i.id)
        .select(({ i, c }) => ({ ...i, company: c.company }))
    },
  })
  const totals = useLiveQuery({
    query: (q) =>
      (s.q ? joinedThenFiltered(q, s) : filteredOnly(q, s))
        .select(({ i }) => ({ n: count(i.id), amount: sum(i.amount) }))
        .findOne(),
  })
  const rows = (joinFirst ? joined.data : paged.data) ?? []
  return { rows, total: totals.data?.n ?? 0, amount: totals.data?.amount ?? 0 }
}

type Row = ReturnType<typeof useInvoiceRows>['rows'][number]
const col = createColumnHelper<ServerFeatures, Row>()
const columns = col.columns([
  col.accessor('number', { header: 'Invoice', cell: (i) => <span className="font-mono text-xs">{i.getValue()}</span> }),
  col.accessor('company', {
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
  const { rows, total, amount } = useInvoiceRows(search)
  const setSearch = (patch: Partial<InvoiceListParams>, resetPage = true) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, ...(resetPage ? { page: 1 } : {}) }), replace: true })

  return (
    <>
      <PageHeader title="Invoices" description="Invoices ⨝ customers, joined, filtered, sorted and paged locally." />
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Stat label="Matching invoices" value={number(total)} testId="invoice-count" />
        <Stat
          label="Total of all matches"
          value={money(amount)}
          hint="Live aggregate over every matching row"
          testId="invoice-total"
        />
        <Stat label="Requests for this page" value={0} hint="Customer names come from a local join" />
      </div>
      <DataTable
        testId="invoices-table"
        columns={columns}
        data={rows}
        rowCount={total}
        pagination={{ pageIndex: search.page - 1, pageSize: search.pageSize }}
        onPaginationChange={(p) => setSearch({ page: p.pageIndex + 1, pageSize: p.pageSize }, p.pageSize !== search.pageSize)}
        sorting={parseSort(search.sort)}
        onSortingChange={(s) => setSearch({ sort: formatSort(s) })}
        toolbar={
          <div className="flex flex-wrap items-center gap-3">
            <input
              className="input w-56"
              placeholder="Invoice # or company"
              value={search.q ?? ''}
              onChange={(e) => setSearch({ q: e.target.value || undefined })}
              aria-label="Search invoices"
            />
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
