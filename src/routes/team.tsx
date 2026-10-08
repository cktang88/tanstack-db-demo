import { caseWhen, count, eq, sum, toArray, useLiveQuery, type Transaction } from '@tanstack/react-db'
import { Activity, useEffect, useState } from 'react'
import { ROLES, type Role } from '../../shared/domain'
import { Avatar, Badge, Card, Empty, PageHeader, Segmented } from '../components/ui'
import { stageReassignment } from '../db/actions'
import {
  permissionsCollection,
  rolePermissionsCollection,
  rolesCollection,
  tasksCollection,
  teamMembersCollection,
  teamsCollection,
  usersCollection,
} from '../db/collections'
import { useCan } from '../lib/auth'
import { date, titleCase } from '../lib/format'
import { toast } from '../lib/toast'

type Draft = { tx: Transaction; count: number }

export function TeamPage() {
  const [tab, setTab] = useState<'members' | 'teams' | 'roles' | 'workload'>('members')
  const [selected, setSelected] = useState<number | null>(null)
  // The staged reassignment lives here, not in <Rebalance>: that panel sits in
  // an <Activity>, whose hidden mode runs effect cleanups. Leaving the page
  // with a preview open rolls it back instead of leaving phantom assignments
  // in the local store until reload.
  const [draft, setDraft] = useState<Draft | null>(null)
  useEffect(() => {
    if (!draft) return
    return () => {
      if (draft.tx.state === 'pending') draft.tx.rollback()
    }
  }, [draft])
  return (
    <>
      <PageHeader
        title="Team"
        description="Members, roles and workload."
        actions={
          <Segmented
            label="Team view"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'members', label: 'Members' },
              { value: 'teams', label: 'Teams' },
              { value: 'roles', label: 'Roles' },
              { value: 'workload', label: 'Workload' },
            ]}
          />
        }
      />
      <Activity mode={tab === 'members' ? 'visible' : 'hidden'}>
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <Members selected={selected} onSelect={setSelected} />
          <MemberTasks userId={selected} />
        </div>
      </Activity>
      <Activity mode={tab === 'teams' ? 'visible' : 'hidden'}>
        <Teams />
      </Activity>
      <Activity mode={tab === 'roles' ? 'visible' : 'hidden'}>
        <RolesMatrix />
      </Activity>
      <Activity mode={tab === 'workload' ? 'visible' : 'hidden'}>
        <Workload draft={draft} setDraft={setDraft} />
      </Activity>
    </>
  )
}

function Members({ selected, onSelect }: { selected: number | null; onSelect: (id: number) => void }) {
  const { data: users } = useLiveQuery({ query: (q) => q.from({ u: usersCollection }).orderBy(({ u }) => u.name) })
  const { can, me } = useCan()
  const canManage = can('team:manage')
  // only an owner can make someone an owner
  const meOwner = me.user.role === 'owner'
  return (
    <Card title={`${users.length} members`}>
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" data-testid="member-list">
        {users.map((u) => (
          <li
            key={u.id}
            className={`flex items-center gap-3 py-2 ${selected === u.id ? 'bg-brand-50/60 dark:bg-brand-500/10' : ''}`}
            data-testid="member-row"
          >
            <Avatar name={u.name} color={u.avatarColor} />
            <button className="min-w-0 flex-1 text-left" onClick={() => onSelect(u.id)}>
              <div className="text-sm font-medium">
                {u.name} {!u.active && <span className="text-xs text-zinc-400">(inactive)</span>}
              </div>
              <div className="truncate text-xs text-zinc-500">
                {u.title} · {u.email}
              </div>
            </button>
            <Badge value={u.role} />
            {/* optimistic by default — no useOptimistic/onMutate/rollback code needed */}
            <select
              className="input w-28"
              aria-label={`Role for ${u.name}`}
              value={u.role}
              // owners can't be demoted here, and nobody changes their own role
              disabled={u.role === 'owner' || u.id === me.user.id || !canManage}
              onChange={(e) =>
                usersCollection
                  .update(u.id, (d) => void (d.role = e.target.value as Role))
                  .when('settled')
                  .catch((err: Error) => toast.error('Could not update teammate — rolled back', err.message))
              }
            >
              {ROLES.filter((r) => r !== 'owner' || meOwner || u.role === 'owner').map((r) => (
                <option key={r} value={r}>
                  {titleCase(r)}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function MemberTasks({ userId }: { userId: number | null }) {
  // A disabled live query (returns undefined) until a member is selected.
  const { data, isEnabled } = useLiveQuery({
    query: (q) =>
      userId === null
        ? undefined
        : q
            .from({ t: tasksCollection })
            .where(({ t }) => eq(t.assigneeId, userId))
            .orderBy(({ t }) => t.dueDate, { direction: 'asc', nulls: 'last' })
            .orderBy(({ t }) => t.id),
  })
  return (
    <Card title="Assigned tasks">
      {!isEnabled ? (
        <Empty>Select a member to see their tasks.</Empty>
      ) : data?.length ? (
        <ul className="space-y-2 text-sm" data-testid="member-tasks">
          {data.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2">
              <span className="truncate">{t.title}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                <Badge value={t.status} />
                <span className="w-20 text-right text-xs text-zinc-400">{date(t.dueDate)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No tasks assigned.</Empty>
      )}
    </Card>
  )
}

function Workload({ draft, setDraft }: { draft: Draft | null; setDraft: (d: Draft | null) => void }) {
  // users ⨝ (tasks GROUP BY assignee) — the old app needed a dedicated /metrics/workload endpoint.
  const { data } = useLiveQuery({
    query: (q) => {
      const perUser = q
        .from({ t: tasksCollection })
        .groupBy(({ t }) => t.assigneeId)
        .select(({ t }) => ({
          assigneeId: t.assigneeId,
          open: sum(caseWhen(eq(t.status, 'done'), 0, 1)),
          done: sum(caseWhen(eq(t.status, 'done'), 1, 0)),
          total: count(t.id),
        }))
      return q
        .from({ u: usersCollection })
        .leftJoin({ w: perUser }, ({ u, w }) => eq(u.id, w.assigneeId))
        .orderBy(({ w }) => w?.open, { direction: 'desc', nulls: 'last' })
        .orderBy(({ u }) => u.name)
        .select(({ u, w }) => ({ userId: u.id, name: u.name, open: w?.open, done: w?.done }))
    },
  })
  const max = Math.max(1, ...data.map((d) => (d.open ?? 0) + (d.done ?? 0)))
  const { can, privileged } = useCan()
  // reassigning across every project needs owner/admin (members may only edit their teams' projects)
  const canRebalance = can('projects:write') && privileged
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <Card title="Open vs done tasks per member">
        <ul className="space-y-2" data-testid="workload">
          {data.map((d) => (
            <li key={d.userId} className="grid grid-cols-[160px_1fr_90px] items-center gap-3 text-sm" data-testid="workload-row">
              <span className="truncate">{d.name}</span>
              <div className="flex h-3 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div className="bg-amber-500 transition-all" style={{ width: `${((d.open ?? 0) / max) * 100}%` }} />
                <div className="bg-emerald-500 transition-all" style={{ width: `${((d.done ?? 0) / max) * 100}%` }} />
              </div>
              <span className="text-right text-xs text-zinc-500 tabular-nums" data-testid="workload-open">
                {d.open ?? 0} open · {d.done ?? 0}
              </span>
            </li>
          ))}
        </ul>
      </Card>
      {canRebalance && <Rebalance users={data} draft={draft} setDraft={setDraft} />}
    </div>
  )
}

/**
 * A manual transaction (autoCommit: false) used as a *draft*: the reassignment
 * is previewed live in the workload chart above, then saved atomically or
 * discarded with rollback().
 */
function Rebalance({
  users,
  draft,
  setDraft,
}: {
  users: Array<{ userId: number; name: string; open?: number }>
  draft: Draft | null
  setDraft: (d: Draft | null) => void
}) {
  const [from, setFrom] = useState<number | ''>('')
  const [to, setTo] = useState<number | ''>('')

  const preview = () => {
    if (from === '' || to === '' || from === to) return
    const staged = stageReassignment(from, to)
    if (!staged.count) {
      staged.tx.rollback()
      toast.info('Nothing to move', 'That member has no open tasks')
      return
    }
    setDraft(staged)
  }
  const discard = () => {
    draft?.tx.rollback()
    setDraft(null)
  }
  const save = () => {
    if (!draft) return
    const { tx, count } = draft
    setDraft(null)
    tx.commit().then(
      () => toast.success(`Reassigned ${count} tasks`),
      (e: Error) => toast.error('Reassignment failed — rolled back', e.message),
    )
  }

  return (
    <Card title="Rebalance workload">
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="label">Move all open tasks from</span>
          <select
            className="input"
            aria-label="From member"
            value={from}
            disabled={!!draft}
            onChange={(e) => setFrom(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">Choose…</option>
            {users.map((u) => (
              <option key={u.userId} value={u.userId}>
                {u.name} ({u.open ?? 0} open)
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">to</span>
          <select
            className="input"
            aria-label="To member"
            value={to}
            disabled={!!draft}
            onChange={(e) => setTo(e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">Choose…</option>
            {users.map((u) => (
              <option key={u.userId} value={u.userId}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        {draft ? (
          <div
            className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10"
            data-testid="rebalance-draft"
          >
            <p className="mb-2">
              Previewing <b>{draft.count}</b> reassigned tasks — nothing has been sent yet.
            </p>
            <div className="flex gap-2">
              <button className="btn-primary" onClick={save}>
                Save
              </button>
              <button className="btn-secondary" onClick={discard}>
                Discard
              </button>
            </div>
          </div>
        ) : (
          <button className="btn-secondary" disabled={from === '' || to === '' || from === to} onClick={preview}>
            Preview
          </button>
        )}
      </div>
    </Card>
  )
}

function Teams() {
  const canManage = useCan().can('team:manage')
  // teams ⨝ lead, with each team's members as a nested array (includes + toArray):
  // one live query instead of three requests stitched together with Maps.
  const { data: teams } = useLiveQuery({
    query: (q) =>
      q
        .from({ t: teamsCollection })
        .leftJoin({ lead: usersCollection }, ({ t, lead }) => eq(t.leadId, lead.id))
        .orderBy(({ t }) => t.name)
        .select(({ t, lead }) => ({
          ...t,
          leadName: lead?.name,
          members: toArray(
            q
              .from({ m: teamMembersCollection })
              .innerJoin({ u: usersCollection }, ({ m, u }) => eq(m.userId, u.id))
              .where(({ m }) => eq(m.teamId, t.id))
              .orderBy(({ u }) => u.name)
              .select(({ m, u }) => ({ id: m.id, userId: u.id, name: u.name, color: u.avatarColor })),
          ),
        })),
  })
  const { data: users } = useLiveQuery({ query: (q) => q.from({ u: usersCollection }).orderBy(({ u }) => u.name) })
  const fail = (e: Error) => toast.error('Membership change failed — rolled back', e.message)
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="teams">
      {teams.map((t) => (
        <Card key={t.id} title={`${t.name} (${t.members.length})`}>
          <p className="mb-3 text-xs text-zinc-500">
            {t.description}
            {t.leadName && ` · lead: ${t.leadName}`}
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {t.members.map((m) => (
              <li
                key={m.id}
                className="flex items-center gap-1 rounded-full bg-zinc-100 py-0.5 pr-2 pl-0.5 text-xs dark:bg-zinc-800"
              >
                <Avatar name={m.name} color={m.color} size={18} /> {m.name}
                {canManage && (
                  <button
                    aria-label={`Remove ${m.name} from ${t.name}`}
                    className="text-zinc-400 hover:text-red-600"
                    onClick={() => teamMembersCollection.delete(m.id).when('settled').catch(fail)}
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canManage && (
            <select
              className="input mt-3"
              aria-label={`Add member to ${t.name}`}
              value=""
              onChange={(e) => {
                const userId = Number(e.target.value)
                if (!userId) return
                teamMembersCollection
                  .insert({ id: `${t.id}:${userId}`, teamId: t.id, userId, joinedAt: new Date().toISOString() })
                  .when('settled')
                  .catch(fail)
              }}
            >
              <option value="">+ Add member…</option>
              {users
                .filter((u) => !t.members.some((m) => m.userId === u.id))
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          )}
        </Card>
      ))}
    </div>
  )
}

function RolesMatrix() {
  const { data: roles } = useLiveQuery({ query: (q) => q.from({ r: rolesCollection }) })
  // permissions with the granted role ids nested per row
  const { data: perms } = useLiveQuery({
    query: (q) =>
      q
        .from({ p: permissionsCollection })
        .orderBy(({ p }) => p.id)
        .select(({ p }) => ({
          ...p,
          roles: toArray(
            q
              .from({ g: rolePermissionsCollection })
              .where(({ g }) => eq(g.permissionId, p.id))
              .select(({ g }) => g.roleId),
          ),
        })),
  })
  return (
    <Card title="Role → permission matrix (role_permissions)">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="roles-matrix">
          <thead>
            <tr>
              <th className="th">Permission</th>
              {roles.map((r) => (
                <th key={r.id} className="th text-center">
                  {r.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {perms.map((p) => (
              <tr key={p.id}>
                <td className="td">
                  <div className="font-mono text-xs">{p.id}</div>
                  <div className="text-xs text-zinc-500">{p.description}</div>
                </td>
                {roles.map((r) => (
                  <td key={r.id} className="td text-center">
                    {p.roles.includes(r.id) ? (
                      <span className="text-emerald-600">✓</span>
                    ) : (
                      <span className="text-zinc-300">—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
