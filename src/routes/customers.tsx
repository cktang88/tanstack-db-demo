import { and, count, eq, ilike, inArray, or, sum, useLiveQuery, type InitialQueryBuilder } from '@tanstack/react-db'
import { Link, useNavigate } from '@tanstack/react-router'
import { createColumnHelper, type RowSelectionState } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { COUNTRIES, CUSTOMER_STATUSES, PLANS } from '../../shared/domain'
import { CustomerForm } from '../components/CustomerForm'
import { DataTable, selectColumn, type ServerFeatures } from '../components/DataTable'
import { Avatar, Badge, ChipFilter, Dialog, PageHeader } from '../components/ui'
import { createCustomer, deleteCustomers, updateCustomers } from '../db/actions'
import { customersCollection, selectionCollection, usersCollection } from '../db/collections'
import { date, money, number } from '../lib/format'
import { formatSort, parseSort, type CustomerListParams } from '../lib/search'
import { useCan } from '../lib/auth'
import { toast } from '../lib/toast'
import { customersRoute } from '../router'

const like = (s: string) => `%${s}%`

/** Filters that only touch customer columns. */
function customerFilters(s: CustomerListParams) {
  return (c: any) =>
    [
      s.status ? inArray(c.status, s.status) : undefined,
      s.plan ? inArray(c.plan, s.plan) : undefined,
      s.country ? inArray(c.country, s.country) : undefined,
      s.ownerId ? eq(c.ownerId, s.ownerId) : undefined,
    ].filter((p) => p !== undefined)
}
const allOf = (parts: any[]) => (parts.length === 1 ? parts[0] : and(parts[0], parts[1], ...parts.slice(2)))

/** customers ⨝ owner, filtered — needed when searching or sorting by the owner's name. */
function joinedThenFiltered(q: InitialQueryBuilder, s: CustomerListParams) {
  const base = q.from({ c: customersCollection }).leftJoin({ u: usersCollection }, ({ c, u }) => eq(c.ownerId, u.id))
  const parts = (c: any, u: any) =>
    [
      ...customerFilters(s)(c),
      // search spans the customer AND the joined owner — something the REST API couldn't do
      s.q
        ? or(ilike(c.name, like(s.q)), ilike(c.email, like(s.q)), ilike(c.company, like(s.q)), ilike(u?.name, like(s.q)))
        : undefined,
    ].filter((p) => p !== undefined)
  if (!s.status && !s.plan && !s.country && !s.ownerId && !s.q) return base
  return base.where(({ c, u }) => allOf(parts(c, u)))
}

/** customers only, filtered — cheaper when the owner isn't involved in filtering/sorting. */
function filteredOnly(q: InitialQueryBuilder, s: CustomerListParams) {
  const base = q.from({ c: customersCollection })
  if (!s.status && !s.plan && !s.country && !s.ownerId) return base
  return base.where(({ c }) => allOf(customerFilters(s)(c)))
}

const SORTABLE = new Set(['company', 'name', 'plan', 'status', 'country', 'seats', 'mrr', 'createdAt', 'owner'])

function useCustomerRows(s: CustomerListParams) {
  const [sort] = parseSort(s.sort)
  const field = sort && SORTABLE.has(sort.id) ? sort.id : 'createdAt'
  const direction = sort?.desc === false ? 'asc' : 'desc'
  const joinFirst = field === 'owner' || !!s.q

  // Path A: join first, because the filter/sort needs the owner (sorting by a joined column!).
  const joined = useLiveQuery({
    query: (q) =>
      joinFirst
        ? joinedThenFiltered(q, s)
            .orderBy(({ c, u }) => (field === 'owner' ? u?.name : c[field as 'company']), { direction, nulls: 'last' })
            .orderBy(({ c }) => c.id)
            .limit(s.pageSize)
            .offset((s.page - 1) * s.pageSize)
            .select(({ c, u }) => ({ ...c, ownerName: u?.name, ownerColor: u?.avatarColor }))
        : undefined, // disabled query
  })
  // Path B: page the customers first (index-backed orderBy+limit), then join just the visible rows.
  const paged = useLiveQuery({
    query: (q) => {
      if (joinFirst) return undefined
      const page = filteredOnly(q, s)
        .orderBy(({ c }) => c[field as 'company'], { direction, nulls: 'last' })
        .orderBy(({ c }) => c.id)
        .limit(s.pageSize)
        .offset((s.page - 1) * s.pageSize)
      return q
        .from({ c: page })
        .leftJoin({ u: usersCollection }, ({ c, u }) => eq(c.ownerId, u.id))
        .orderBy(({ c }) => c[field as 'company'], { direction, nulls: 'last' })
        .orderBy(({ c }) => c.id)
        .select(({ c, u }) => ({ ...c, ownerName: u?.name, ownerColor: u?.avatarColor }))
    },
  })
  const total = useLiveQuery({
    query: (q) =>
      (s.q ? joinedThenFiltered(q, s) : filteredOnly(q, s)).select(({ c }) => ({ n: count(c.id), mrr: sum(c.mrr) })).findOne(),
  })
  const rows = (joinFirst ? joined.data : paged.data) ?? []
  return { rows, total: total.data?.n ?? 0, totalMrr: total.data?.mrr ?? 0 }
}

type Row = ReturnType<typeof useCustomerRows>['rows'][number]
const col = createColumnHelper<ServerFeatures, Row>()

const columns = col.columns([
  selectColumn<Row>(),
  col.accessor('company', {
    header: 'Company',
    cell: (info) => (
      <Link
        to="/customers/$customerId"
        params={{ customerId: info.row.original.id }}
        className="font-medium hover:text-brand-600"
      >
        {info.getValue()}
      </Link>
    ),
  }),
  col.accessor('name', {
    header: 'Contact',
    cell: (info) => (
      <div>
        <div>{info.getValue()}</div>
        <div className="text-xs text-zinc-500">{info.row.original.email}</div>
      </div>
    ),
  }),
  col.accessor('plan', { header: 'Plan', cell: (i) => <Badge value={i.getValue()} /> }),
  col.accessor('status', { header: 'Status', cell: (i) => <Badge value={i.getValue()} /> }),
  col.accessor('country', { header: 'Country' }),
  col.accessor('seats', { header: 'Seats', cell: (i) => <span className="tabular-nums">{i.getValue()}</span> }),
  col.accessor('mrr', { header: 'MRR', cell: (i) => <span className="tabular-nums">{money(i.getValue())}</span> }),
  col.accessor('ownerName', {
    id: 'owner',
    header: 'Owner',
    cell: (i) =>
      i.getValue() ? (
        <span className="flex items-center gap-2">
          <Avatar name={i.getValue()!} color={i.row.original.ownerColor} size={22} />
          {i.getValue()}
        </span>
      ) : (
        <span className="text-zinc-400">—</span>
      ),
  }),
  col.accessor('createdAt', { header: 'Created', cell: (i) => date(i.getValue()) }),
  col.display({
    id: 'sync',
    header: '',
    enableHiding: false,
    cell: ({ row }) =>
      (row.original as { $hasPendingWrites?: boolean }).$hasPendingWrites ? (
        <span className="text-xs text-amber-600" title="Optimistic change not yet confirmed by the server">
          saving…
        </span>
      ) : null,
  }),
])

export function CustomersPage() {
  const search = customersRoute.useSearch()
  const navigate = useNavigate({ from: '/customers' })
  const { rows, total, totalMrr } = useCustomerRows(search)
  const { can, canEditCustomer } = useCan()
  const [creating, setCreating] = useState(false)

  // Selection lives in a local-only collection: it survives paging & filtering,
  // and can be joined with customers for a live summary.
  const { data: selected } = useLiveQuery({ query: (q) => q.from({ s: selectionCollection }) })
  const rowSelection = useMemo<RowSelectionState>(() => Object.fromEntries(selected.map((s) => [String(s.id), true])), [selected])
  const { data: selectionSummary } = useLiveQuery({
    query: (q) =>
      q
        .from({ s: selectionCollection })
        .innerJoin({ c: customersCollection }, ({ s, c }) => eq(s.id, c.id))
        .select(({ c }) => ({ n: count(c.id), mrr: sum(c.mrr) }))
        .findOne(),
  })

  const setSearch = (patch: Partial<CustomerListParams>, resetPage = true) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, ...(resetPage ? { page: 1 } : {}) }), replace: true })

  const onRowSelectionChange = (next: RowSelectionState) => {
    const add = Object.keys(next).filter((k) => next[k] && !rowSelection[k])
    const remove = Object.keys(rowSelection).filter((k) => !next[k])
    if (add.length) selectionCollection.insert(add.map((id) => ({ id: Number(id) })))
    if (remove.length) selectionCollection.delete(remove.map(Number))
  }
  const clearSelection = () => {
    if (selected.length) selectionCollection.delete(selected.map((s) => s.id))
  }
  /**
   * Bulk actions only touch rows that still exist locally (a selection can
   * outlive its rows — update/delete of a missing key throws) and that the
   * user may change (members: accounts they own, as the server enforces).
   */
  const actionable = (ids: number[]) => {
    const ok = ids.filter((id) => {
      const c = customersCollection.get(id)
      return c !== undefined && canEditCustomer(c)
    })
    const gone = ids.filter((id) => !customersCollection.has(id) && selectionCollection.has(id))
    if (gone.length) selectionCollection.delete(gone)
    const skipped = ids.length - ok.length
    if (skipped)
      toast.info(
        `Skipped ${skipped} customer${skipped === 1 ? '' : 's'}`,
        'Not found any more, or not yours to change',
      )
    return ok
  }

  return (
    <>
      <PageHeader
        title="Customers"
        description={`${number(total)} matching · ${money(totalMrr)} MRR — filtering, sorting & paging run locally, no requests.`}
        actions={
          can('customers:write') && (
            <button className="btn-primary" onClick={() => setCreating(true)}>
              + New customer
            </button>
          )
        }
      />
      <DataTable
        testId="customers-table"
        columns={columns}
        data={rows}
        rowCount={total}
        pagination={{ pageIndex: search.page - 1, pageSize: search.pageSize }}
        onPaginationChange={(p) => setSearch({ page: p.pageIndex + 1, pageSize: p.pageSize }, p.pageSize !== search.pageSize)}
        sorting={parseSort(search.sort)}
        onSortingChange={(s) => setSearch({ sort: formatSort(s) })}
        rowSelection={rowSelection}
        onRowSelectionChange={onRowSelectionChange}
        rowClassName={(r) =>
          (r as { $hasPendingWrites?: boolean }).$hasPendingWrites ? 'bg-amber-50/50 dark:bg-amber-500/5' : undefined
        }
        toolbar={
          <div className="flex flex-wrap items-center gap-3">
            {/* no debounce needed: each keystroke re-runs an in-memory query */}
            <input
              className="input w-64"
              placeholder="Search name, email, company, owner…"
              value={search.q ?? ''}
              onChange={(e) => setSearch({ q: e.target.value || undefined })}
              aria-label="Search customers"
            />
            <ChipFilter
              label="Status"
              options={CUSTOMER_STATUSES}
              value={search.status ?? []}
              onChange={(status) => setSearch({ status: status.length ? status : undefined })}
            />
            <ChipFilter
              label="Plan"
              options={PLANS}
              value={search.plan ?? []}
              onChange={(plan) => setSearch({ plan: plan.length ? plan : undefined })}
            />
            <select
              className="input w-28"
              aria-label="Country"
              value={search.country?.[0] ?? ''}
              onChange={(e) => setSearch({ country: e.target.value ? [e.target.value] : undefined })}
            >
              <option value="">Country</option>
              {COUNTRIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <OwnerFilter value={search.ownerId} onChange={(ownerId) => setSearch({ ownerId })} />
          </div>
        }
        bulkActions={(ids) =>
          !can('customers:write') ? (
            <span className="text-zinc-500">read-only</span>
          ) : (
            <>
              <span className="text-zinc-500" data-testid="selection-summary">
                ({number(selectionSummary?.n ?? 0)} across all pages · {money(selectionSummary?.mrr ?? 0)} MRR)
              </span>
              {CUSTOMER_STATUSES.map((s) => (
                <button
                  key={s}
                  className="btn-secondary py-1 text-xs"
                  onClick={() => {
                    const editable = actionable(ids)
                    clearSelection()
                    if (!editable.length) return
                    // one transaction for N rows -> one atomic /api/batch request
                    const tx = updateCustomers(editable, { status: s })
                    tx.when('settled').then(
                      () => toast.success(`Updated ${editable.length} customers`),
                      (e: Error) => toast.error('Bulk update failed — rolled back', e.message),
                    )
                  }}
                >
                  Mark {s}
                </button>
              ))}
              {can('customers:delete') && (
                <button
                  className="btn-danger py-1 text-xs"
                  onClick={() => {
                    if (!confirm(`Archive ${ids.length} customers?`)) return
                    const archivable = actionable(ids)
                    if (!archivable.length) return
                    deleteCustomers(archivable)
                      .when('settled')
                      .then(
                        () => toast.success(`Archived ${archivable.length} customer${archivable.length === 1 ? '' : 's'}`),
                        (e: Error) => toast.error('Archive failed — rows restored', e.message),
                      )
                  }}
                >
                  Archive
                </button>
              )}
              <button className="btn-ghost py-1 text-xs" onClick={clearSelection}>
                Clear
              </button>
            </>
          )
        }
      />
      <Dialog open={creating} onClose={() => setCreating(false)} title="New customer">
        <CustomerForm
          submitLabel="Create customer"
          onSubmit={async (values) => {
            // the row is inserted locally with its final id and appears immediately…
            const { tx } = createCustomer(values)
            setCreating(false)
            // …the server confirmation (or rollback) happens in the background
            tx.when('settled').then(
              () => toast.success('Customer created', values.company),
              (e: Error) => toast.error('Could not create customer — removed', e.message),
            )
          }}
        />
      </Dialog>
    </>
  )
}

function OwnerFilter({ value, onChange }: { value?: number; onChange: (v?: number) => void }) {
  const { data: users } = useLiveQuery({ query: (q) => q.from({ u: usersCollection }).orderBy(({ u }) => u.name) })
  return (
    <select
      className="input w-40"
      aria-label="Owner"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
    >
      <option value="">Any owner</option>
      {users.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </select>
  )
}
