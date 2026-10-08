import { noop, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { useCallback, useEffect, useMemo } from 'react'
import { INVOICE_STATUSES, type Customer, type Invoice } from '../../shared/domain'
import { DataTable, type ServerFeatures } from '../components/DataTable'
import { Badge, ChipFilter, PageHeader, Stat } from '../components/ui'
import { date, money, number } from '../lib/format'
import { useMarkInvoicePaid } from '../lib/mutations'
import { customerQuery, invoicesListQuery, type InvoiceListParams } from '../lib/queries'
import { formatSort, parseSort } from '../lib/search'
import { invoicesRoute } from '../router'
import { useCan } from '../lib/auth'

const col = createColumnHelper<ServerFeatures, Invoice>()
const EMPTY: Invoice[] = []

export function InvoicesPage() {
  const search = invoicesRoute.useSearch()
  const navigate = useNavigate({ from: '/invoices' })
  const qc = useQueryClient()
  const query = useQuery(invoicesListQuery(search))
  const markPaid = useMarkInvoicePaid()
  const canPay = useCan().can('billing:write')
  const rows = query.data?.data ?? EMPTY

  // The invoice API only returns customerId. To show the company name we fan
  // out one request per distinct customer on the page and stitch them together
  // client-side (useQueries + combine). Cached per customer, but still N calls.
  const customerIds = useMemo(() => [...new Set(rows.map((r) => r.customerId))], [rows])
  const customers = useQueries({
    queries: customerIds.map((id) => ({ ...customerQuery(id), staleTime: 5 * 60_000 })),
    combine: useCallback(
      (results: Array<{ data?: Customer }>) => new Map(results.flatMap((r) => (r.data ? [[r.data.id, r.data] as const] : []))),
      [],
    ),
  })

  const setSearch = (patch: Partial<InvoiceListParams>, resetPage = true) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, ...(resetPage ? { page: 1 } : {}) }), replace: true })

  const pageCount = query.data?.pageCount ?? 1
  useEffect(() => {
    if (search.page < pageCount) void qc.query(invoicesListQuery({ ...search, page: search.page + 1 })).catch(noop)
  }, [qc, search, pageCount])

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor('number', { header: 'Invoice', cell: (i) => <span className="font-mono text-xs">{i.getValue()}</span> }),
        col.accessor('customerId', {
          header: 'Customer',
          enableSorting: false,
          cell: (i) => {
            const c = customers.get(i.getValue())
            return (
              <Link to="/customers/$customerId" params={{ customerId: i.getValue() }} className="hover:text-brand-600">
                {c?.company ?? <span className="inline-block h-3 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-800" />}
              </Link>
            )
          },
        }),
        col.accessor('status', { header: 'Status', cell: (i) => <Badge value={i.getValue()} /> }),
        col.accessor('issuedAt', { header: 'Issued', cell: (i) => date(i.getValue()) }),
        col.accessor('dueAt', { header: 'Due', cell: (i) => date(i.getValue()) }),
        col.accessor('paidAt', { header: 'Paid', cell: (i) => date(i.getValue()) }),
        col.accessor('amount', { header: 'Amount', cell: (i) => <span className="tabular-nums">{money(i.getValue())}</span> }),
        col.display({
          id: 'actions',
          header: '',
          cell: ({ row }) =>
            canPay && (row.original.status === 'open' || row.original.status === 'overdue') ? (
              <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => markPaid.mutate(row.original.id)}>
                Mark paid
              </button>
            ) : null,
        }),
      ]),
    [customers, markPaid, canPay],
  )

  const pageTotal = rows.reduce((s, r) => s + r.amount, 0)

  return (
    <>
      <PageHeader title="Invoices" description="Billing history across all accounts." />
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Stat label="Matching invoices" value={number(query.data?.total ?? 0)} />
        <Stat label="This page total" value={money(pageTotal)} hint="Totals for all matches need another endpoint" />
        <Stat label="Customer lookups on this page" value={customerIds.length} hint="One request per distinct customer" />
      </div>
      <DataTable
        testId="invoices-table"
        columns={columns}
        data={rows}
        rowCount={query.data?.total ?? 0}
        isFetching={query.isFetching}
        isPlaceholder={query.isPlaceholderData}
        pagination={{ pageIndex: search.page - 1, pageSize: search.pageSize }}
        onPaginationChange={(p) => setSearch({ page: p.pageIndex + 1, pageSize: p.pageSize }, p.pageSize !== search.pageSize)}
        sorting={parseSort(search.sort)}
        onSortingChange={(s) => setSearch({ sort: formatSort(s) })}
        toolbar={
          <div className="flex flex-wrap items-center gap-3">
            <input
              className="input w-44"
              placeholder="Invoice #"
              defaultValue={search.q}
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
