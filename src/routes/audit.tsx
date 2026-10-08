import { and, eq, useLiveQuery } from '@tanstack/react-db'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { useMemo } from 'react'
import { AUDIT_ACTIONS } from '../../shared/domain'
import { DataTable, type ServerFeatures } from '../components/DataTable'
import { Avatar, Badge, PageHeader } from '../components/ui'
import { date, relative } from '../lib/format'
import { auditCollection, usersCollection } from '../db/collections'
import { usePageAnchor, usePagedWindow, WINDOW } from '../db/hooks'
import { listTotalQuery } from '../db/aggregates'
import { MAX_ROWS } from '../db/pushdown'
import type { AuditParams } from '../lib/search'
import { auditRoute } from '../router'

const ENTITIES = [
  'customers',
  'subscriptions',
  'invoices',
  'payments',
  'tasks',
  'task-comments',
  'time-entries',
  'users',
  'team-members',
  'projects',
  'products',
  'sessions',
  'jobs',
]

function Changes({ json }: { json: string }) {
  const changes = useMemo(() => {
    try {
      return Object.entries(JSON.parse(json) as Record<string, unknown>)
    } catch {
      return []
    }
  }, [json])
  if (!changes.length) return <span className="text-zinc-400">—</span>
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
      {changes.slice(0, 4).map(([k, v]) => (
        <span key={k}>
          <span className="text-zinc-500">{k}</span>{' '}
          {Array.isArray(v) ? (
            <>
              <s className="text-red-500">{JSON.stringify(v[0])}</s> →{' '}
              <span className="text-emerald-600">{JSON.stringify(v[1])}</span>
            </>
          ) : (
            <span>{JSON.stringify(v)}</span>
          )}
        </span>
      ))}
      {changes.length > 4 && <span className="text-zinc-400">+{changes.length - 4}</span>}
    </span>
  )
}

function useAuditRows(search: AuditParams) {
  // On-demand: filters + window pushed down (action[eq]/entity[eq]/actorId[eq], sort=-id, limit/offset);
  // the actor join happens locally against the eager users collection.
  const anchor = usePageAnchor((search.page - 1) * search.pageSize, search.pageSize)
  const rows = useLiveQuery({
    ...WINDOW,
    query: (q) => {
      const base = q.from({ a: auditCollection })
      const conds = (a: any) =>
        [
          search.action ? eq(a.action, search.action) : undefined,
          search.entity ? eq(a.entity, search.entity) : undefined,
          search.actorId ? eq(a.actorId, search.actorId) : undefined,
        ].filter((x) => x !== undefined)
      const filtered =
        search.action || search.entity || search.actorId
          ? base.where(({ a }) => {
              const c = conds(a)
              return c.length === 1 ? c[0]! : and(c[0]!, c[1]!, ...c.slice(2))
            })
          : base
      return filtered
        .leftJoin({ u: usersCollection }, ({ a, u }) => eq(a.actorId, u.id))
        .orderBy(({ a }) => a.id, 'desc')
        .limit(search.pageSize)
        .offset(anchor)
        .select(({ a, u }) => ({ ...a, actorName: u?.name, actorColor: u?.avatarColor }))
    },
  })
  return usePagedWindow(rows, (search.page - 1) * search.pageSize, search.pageSize).rows
}

type Row = ReturnType<typeof useAuditRows>[number]
const col = createColumnHelper<ServerFeatures, Row>()
const columns = col.columns([
  col.accessor('at', {
    header: 'When',
    enableSorting: false,
    cell: (i) => <span title={date(i.getValue())}>{relative(i.getValue())}</span>,
  }),
  col.accessor('actorName', {
    header: 'Actor',
    enableSorting: false,
    cell: (i) =>
      i.getValue() ? (
        <span className="flex items-center gap-2">
          <Avatar name={i.getValue()!} color={i.row.original.actorColor} size={20} /> {i.getValue()}
        </span>
      ) : (
        'system'
      ),
  }),
  col.accessor('action', {
    header: 'Action',
    enableSorting: false,
    cell: (i) => <Badge value={i.getValue()} tone={i.getValue() === 'denied' ? 'red' : undefined} />,
  }),
  col.accessor('entity', {
    header: 'Entity',
    enableSorting: false,
    cell: (i) => (
      <span className="font-mono text-xs">
        {i.getValue()}
        {i.row.original.entityId ? `#${i.row.original.entityId}` : ''}
      </span>
    ),
  }),
  col.accessor('changes', { header: 'Changes', enableSorting: false, cell: (i) => <Changes json={i.getValue()} /> }),
])

export function AuditPage() {
  const search = auditRoute.useSearch()
  const navigate = useNavigate({ from: '/audit' })
  const { data: users } = useLiveQuery({ query: (q) => q.from({ u: usersCollection }).orderBy(({ u }) => u.name) })
  const rows = useAuditRows(search)
  // the pager's total: a server count (the log itself is only ever loaded a window at a time)
  const total =
    useQuery(listTotalQuery('audit-log', { action: search.action, entity: search.entity, actorId: search.actorId })).data
      ?.total ?? 0
  const set = (patch: Partial<AuditParams>) =>
    navigate({ search: (p) => ({ ...p, ...patch, page: patch.page ?? 1 }), replace: true })
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only (enforced by SQLite triggers). Every write, login and denied request is recorded with a field-level diff."
      />
      <DataTable
        testId="audit-table"
        columns={columns}
        data={rows}
        rowCount={total}
        maxRows={MAX_ROWS}
        pagination={{ pageIndex: search.page - 1, pageSize: search.pageSize }}
        onPaginationChange={(p) => set({ page: p.pageIndex + 1, pageSize: p.pageSize })}
        sorting={[]}
        onSortingChange={() => {}}
        toolbar={
          <div className="flex flex-wrap items-center gap-3">
            <select
              className="input w-32"
              aria-label="Action"
              value={search.action ?? ''}
              onChange={(e) => set({ action: e.target.value || undefined })}
            >
              <option value="">Any action</option>
              {AUDIT_ACTIONS.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
            <select
              className="input w-40"
              aria-label="Entity"
              value={search.entity ?? ''}
              onChange={(e) => set({ entity: e.target.value || undefined })}
            >
              <option value="">Any entity</option>
              {ENTITIES.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
            <select
              className="input w-44"
              aria-label="Actor"
              value={search.actorId ?? ''}
              onChange={(e) => set({ actorId: e.target.value ? Number(e.target.value) : undefined })}
            >
              <option value="">Anyone</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
        }
      />
    </>
  )
}
