import { noop, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { useEffect, useMemo, useState } from 'react'
import { COUNTRIES, CUSTOMER_STATUSES, PLANS, type Customer, type User } from '../../shared/domain'
import { CustomerForm } from '../components/CustomerForm'
import { DataTable, selectColumn, type ServerFeatures } from '../components/DataTable'
import { Avatar, Badge, ChipFilter, Dialog, PageHeader } from '../components/ui'
import { idsOf } from '../lib/alerts'
import { date, money, number } from '../lib/format'
import { useBulkUpdateCustomers, useCreateCustomer, useDeleteCustomers } from '../lib/mutations'
import {
  customerQuery,
  customersByIdsQuery,
  customersListQuery,
  distinctIds,
  usersQuery,
  type CustomerListParams,
} from '../lib/queries'
import { customerSelection, selectedIds, useSelection } from '../lib/selection'
import { toast } from '../lib/toast'
import { formatSort, parseSort } from '../lib/search'
import { customersRoute } from '../router'
import { useCan } from '../lib/auth'
import { useDebouncedParam } from '../lib/hooks'

const col = createColumnHelper<ServerFeatures, Customer>()
const EMPTY: Customer[] = []
const NO_CUSTOMERS = new Map<number, Customer>()

/** Customers with a write of ours still in flight (optimistic, not yet confirmed by the server). */
function usePendingCustomerIds() {
  const variables = useMutationState({
    filters: { mutationKey: ['customers'], status: 'pending' },
    select: (m) => m.state.variables,
  })
  return useMemo(() => new Set(variables.flatMap(idsOf)), [variables])
}

function useColumns(users: User[], pending: ReadonlySet<number>) {
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
      // sorted by the owner's *name* on the server (a virtual sort key)
      col.accessor('ownerId', {
        id: 'owner',
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
      col.display({
        id: 'sync',
        header: '',
        enableHiding: false,
        cell: ({ row }) =>
          pending.has(row.original.id) ? (
            <span className="text-xs text-amber-600" title="Optimistic change not yet confirmed by the server">
              saving…
            </span>
          ) : null,
      }),
    ])
  }, [users, pending])
}

export function CustomersPage() {
  const { can, canEditCustomer, privileged, me } = useCan()
  const search = customersRoute.useSearch()
  const navigate = useNavigate({ from: '/customers' })
  const qc = useQueryClient()
  const { data: users = [] } = useQuery(usersQuery())
  const query = useQuery(customersListQuery(search))
  const pending = usePendingCustomerIds()
  const columns = useColumns(users, pending)
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

  // The selection lives outside the page (it survives paging, sorting and filtering). The
  // selected rows — on any page — are fetched in ONE batched request (`?id=1,2,3`) for the
  // summary and to know which of them we may change.
  const [selection, setSelection] = useSelection(customerSelection, me.user.id)
  const selected = useMemo(() => distinctIds(selectedIds(selection)), [selection])
  const { data: selectedRows = NO_CUSTOMERS } = useQuery(customersByIdsQuery(selected))
  // rows on screen are the freshest copy; the batched lookup covers the other pages
  const selectedCustomers = useMemo(
    () => selected.flatMap((id) => rows.find((r) => r.id === id) ?? selectedRows.get(id) ?? []),
    [selected, rows, selectedRows],
  )
  const selectedMrr = selectedCustomers.reduce((s, c) => s + c.mrr, 0)

  // Debounced search box that writes to the URL.
  const [q, setQ] = useDebouncedParam(search.q, (q) => setSearch({ q }))

  return (
    <>
      <PageHeader
        title="Customers"
        description={`${number(query.data?.total ?? 0)} matching · ${money(query.data?.sums.mrr ?? 0)} MRR — filtering, sorting & paging run on the server.`}
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
        rowClassName={(r) => (pending.has(r.id) ? 'bg-amber-50/50 dark:bg-amber-500/5' : undefined)}
        pagination={{ pageIndex: search.page - 1, pageSize: search.pageSize }}
        onPaginationChange={(p) => setSearch({ page: p.pageIndex + 1, pageSize: p.pageSize }, p.pageSize !== search.pageSize)}
        sorting={parseSort(search.sort)}
        onSortingChange={(s) => setSearch({ sort: formatSort(s) })}
        onRowHover={(c) => void qc.query(customerQuery(c.id)).catch(noop)}
        toolbar={
          <div className="flex flex-wrap items-center gap-3">
            <input
              className="input w-64"
              placeholder="Search name, email, company, owner…"
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
          if (!can('customers:write')) return <span className="text-zinc-500">read-only</span>
          // Only act on selected rows (on any page) that still exist and that the server will
          // let us change (members: their own accounts) instead of firing doomed requests.
          const editable = selectedCustomers.filter(canEditCustomer).map((c) => c.id)
          const actionable = (targets: number[]) => {
            const skipped = ids.length - targets.length
            if (skipped)
              toast.info(`Skipped ${skipped} customer${skipped === 1 ? '' : 's'}`, 'Not found any more, or not yours to change')
            return targets
          }
          return (
            <>
              <span className="text-zinc-500" data-testid="selection-summary">
                ({number(selectedCustomers.length)} across all pages · {money(selectedMrr)} MRR)
              </span>
              {editable.length < ids.length && (
                <span className="text-xs text-zinc-500" data-testid="bulk-editable">
                  {editable.length} you can edit
                </span>
              )}
              {CUSTOMER_STATUSES.map((s) => (
                <button
                  key={s}
                  className="btn-secondary py-1 text-xs"
                  onClick={() => {
                    const targets = actionable(editable)
                    if (targets.length) bulk.mutate({ ids: targets, patch: { status: s } }, { onSuccess: clear })
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
                    const targets = actionable(editable)
                    if (targets.length) del.mutate(targets, { onSuccess: clear })
                  }}
                >
                  Archive
                </button>
              )}
              <button className="btn-ghost py-1 text-xs" onClick={clear}>
                Clear
              </button>
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
