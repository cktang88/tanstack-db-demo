import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { createColumnHelper } from '@tanstack/react-table'
import { useMemo } from 'react'
import { AUDIT_ACTIONS, type AuditEntry, type User } from '../../shared/domain'
import { DataTable, type ServerFeatures } from '../components/DataTable'
import { Avatar, Badge, PageHeader } from '../components/ui'
import { date, relative } from '../lib/format'
import { resourcePage, usersQuery } from '../lib/queries'
import type { AuditParams } from '../lib/search'
import { auditRoute } from '../router'

const col = createColumnHelper<ServerFeatures, AuditEntry>()
const EMPTY: AuditEntry[] = []
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

export function AuditPage() {
  const search = auditRoute.useSearch()
  const navigate = useNavigate({ from: '/audit' })
  const { data: users = [] } = useQuery(usersQuery())
  const byId = useMemo(() => new Map<number, User>(users.map((u) => [u.id, u])), [users])
  const query = useQuery(
    resourcePage<AuditEntry>('audit-log', {
      page: search.page,
      pageSize: search.pageSize,
      sort: '-id',
      action: search.action,
      entity: search.entity,
      actorId: search.actorId,
    }),
  )
  const set = (patch: Partial<AuditParams>) =>
    navigate({ search: (p) => ({ ...p, ...patch, page: patch.page ?? 1 }), replace: true })
  const columns = useMemo(
    () =>
      col.columns([
        col.accessor('at', {
          header: 'When',
          enableSorting: false,
          cell: (i) => <span title={date(i.getValue())}>{relative(i.getValue())}</span>,
        }),
        col.accessor('actorId', {
          header: 'Actor',
          enableSorting: false,
          cell: (i) => {
            const u = i.getValue() ? byId.get(i.getValue()!) : undefined
            return u ? (
              <span className="flex items-center gap-2">
                <Avatar name={u.name} color={u.avatarColor} size={20} /> {u.name}
              </span>
            ) : (
              'system'
            )
          },
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
      ]),
    [byId],
  )
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only (enforced by SQLite triggers). Every write, login and denied request is recorded with a field-level diff."
      />
      <DataTable
        testId="audit-table"
        columns={columns}
        data={query.data?.data ?? EMPTY}
        rowCount={query.data?.total ?? 0}
        isFetching={query.isFetching}
        isPlaceholder={query.isPlaceholderData}
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
