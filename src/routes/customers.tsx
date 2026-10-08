import { noop, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { createColumnHelper, type RowSelectionState } from '@tanstack/react-table'
import { useEffect, useMemo, useState } from 'react'
import { COUNTRIES, CUSTOMER_STATUSES, PLANS, type Customer, type User } from '../../shared/domain'
import { CustomerForm } from '../components/CustomerForm'
import { DataTable, selectColumn, type ServerFeatures } from '../components/DataTable'
import { Avatar, Badge, ChipFilter, Dialog, PageHeader } from '../components/ui'
import { date, money } from '../lib/format'
import { useBulkUpdateCustomers, useCreateCustomer, useDeleteCustomers } from '../lib/mutations'
import { customerQuery, customersListQuery, usersQuery, type CustomerListParams } from '../lib/queries'
import { formatSort, parseSort } from '../lib/search'
import { customersRoute } from '../router'
import { useCan } from '../lib/auth'
import { useDebouncedParam } from '../lib/hooks'

const col = createColumnHelper<ServerFeatures, Customer>()
const EMPTY: Customer[] = []

function useColumns(users: User[]) {
  return useMemo(() => {
    const byId = new Map(users.map((u) => [u.id, u]))
    return col.columns([
      selectColumn<Customer>(),
      col.accessor('company', {
        header: 'Company',
        cell: (info) => (
          <Link
            to="/customers/$customerId"
            params={{ customerId: info.row.original.id }}
            className="font-medium hover:text-brand-600"
            preload="intent"
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
      col.accessor('ownerId', {
        header: 'Owner',
        cell: (i) => {
          const u = i.getValue() ? byId.get(i.getValue()!) : undefined
          return u ? (
            <span className="flex items-center gap-2">
              <Avatar name={u.name} color={u.avatarColor} size={22} />
              {u.name}
            </span>
          ) : (
            <span className="text-zinc-400">—</span>
          )
        },
      }),
      col.accessor('createdAt', { header: 'Created', cell: (i) => date(i.getValue()) }),
    ])
  }, [users])
}

export function CustomersPage() {
  const { can, canEditCustomer, privileged, me } = useCan()
  const search = customersRoute.useSearch()
  const navigate = useNavigate({ from: '/customers' })
  const qc = useQueryClient()
  const { data: users = [] } = useQuery(usersQuery())
  const query = useQuery(customersListQuery(search))
  const columns = useColumns(users)
  const [creating, setCreating] = useState(false)
  const create = useCreateCustomer()
  const bulk = useBulkUpdateCustomers()
  const del = useDeleteCustomers()
  const rows = query.data?.data ?? EMPTY

  const setSearch = (patch: Partial<CustomerListParams>, resetPage = true) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, ...(resetPage ? { page: 1 } : {}) }), replace: true })

  // Prefetch the next page so paging forward is instant.
  const pageCount = query.data?.pageCount ?? 1
  useEffect(() => {
    if (search.page < pageCount) void qc.query(customersListQuery({ ...search, page: search.page + 1 })).catch(noop)
  }, [qc, search, pageCount])

  // Past the end (e.g. after archiving the last rows, or a stale link): go to the last page.
  const lastPage = query.data && !query.isPlaceholderData ? Math.max(1, query.data.pageCount) : undefined
  useEffect(() => {
    if (lastPage !== undefined && search.page > lastPage)
      void navigate({ search: (prev) => ({ ...prev, page: lastPage }), replace: true })
  }, [navigate, search.page, lastPage])

  // Selection only makes sense for the rows on screen: clear it when the page, sort or filters change.
  const [selection, setSelection] = useState<RowSelectionState>({})
  const searchKey = JSON.stringify(search)
  const [selectionFor, setSelectionFor] = useState(searchKey)
  if (selectionFor !== searchKey) {
    setSelectionFor(searchKey)
    setSelection({})
  }

  // Debounced search box that writes to the URL.
  const [q, setQ] = useDebouncedParam(search.q, (q) => setSearch({ q }))

  return (
    <>
      <PageHeader
        title="Customers"
        description="Server-side pagination, sorting and filtering — every interaction is a new API request."
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
        rowCount={query.data?.total ?? 0}
        isFetching={query.isFetching}
        isPlaceholder={query.isPlaceholderData}
        rowSelection={selection}
        onRowSelectionChange={setSelection}
        pagination={{ pageIndex: search.page - 1, pageSize: search.pageSize }}
        onPaginationChange={(p) => setSearch({ page: p.pageIndex + 1, pageSize: p.pageSize }, p.pageSize !== search.pageSize)}
        sorting={parseSort(search.sort)}
        onSortingChange={(s) => setSearch({ sort: formatSort(s) })}
        onRowHover={(c) => void qc.query(customerQuery(c.id)).catch(noop)}
        toolbar={
          <div className="flex flex-wrap items-center gap-3">
            <input
              className="input w-64"
              placeholder="Search name, email, company…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
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
              onChange={(e) =>
                setSearch({ country: e.target.value ? [e.target.value as (typeof COUNTRIES)[number]] : undefined })
              }
            >
              <option value="">Country</option>
              {COUNTRIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            <select
              className="input w-40"
              aria-label="Owner"
              value={search.ownerId ?? ''}
              onChange={(e) => setSearch({ ownerId: e.target.value ? Number(e.target.value) : undefined })}
            >
              <option value="">Any owner</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
        }
        bulkActions={(ids, clear) => {
          // Only act on rows that are still listed and that the server will let us
          // change (members: their own accounts) instead of firing doomed requests.
          const selected = ids.flatMap((id) => rows.find((r) => r.id === id) ?? [])
          const editable = selected.filter(canEditCustomer).map((c) => c.id)
          const archivable = can('customers:delete') ? editable : []
          if (!editable.length) return <span className="text-zinc-500">read-only</span>
          return (
            <>
              {editable.length < ids.length && (
                <span className="text-xs text-zinc-500" data-testid="bulk-editable">
                  {editable.length} you can edit
                </span>
              )}
              {CUSTOMER_STATUSES.map((s) => (
                <button
                  key={s}
                  className="btn-secondary py-1 text-xs"
                  onClick={() => bulk.mutate({ ids: editable, patch: { status: s } }, { onSuccess: clear })}
                >
                  Mark {s}
                </button>
              ))}
              {archivable.length > 0 && (
                <button
                  className="btn-danger py-1 text-xs"
                  onClick={() => {
                    if (confirm(`Archive ${archivable.length} customers?`)) del.mutate(archivable, { onSuccess: clear })
                  }}
                >
                  Archive
                </button>
              )}
            </>
          )
        }}
      />
      <Dialog open={creating} onClose={() => setCreating(false)} title="New customer">
        <CustomerForm
          submitLabel="Create customer"
          // members always own the accounts they create (the server enforces it)
          initial={privileged ? undefined : { ownerId: me.user.id }}
          canAssignOwner={privileged}
          onSubmit={(v) => create.mutateAsync(v)}
          onDone={() => setCreating(false)}
        />
      </Dialog>
    </>
  )
}
