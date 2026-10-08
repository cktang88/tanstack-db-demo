import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Activity, useOptimistic, useState, useTransition } from 'react'
import { ROLES, type Role, type User } from '../../shared/domain'
import { Avatar, Badge, Card, Empty, PageHeader, Segmented, Skeleton } from '../components/ui'
import { date, titleCase } from '../lib/format'
import { useUpdateUser } from '../lib/mutations'
import { assigneeTasksQuery, usersQuery, workloadQuery } from '../lib/queries'

export function TeamPage() {
  const [tab, setTab] = useState<'members' | 'workload'>('members')
  const [selected, setSelected] = useState<number | null>(null)
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
              { value: 'workload', label: 'Workload' },
            ]}
          />
        }
      />
      {/* <Activity> keeps the hidden tab mounted (state + scroll preserved) at low priority */}
      <Activity mode={tab === 'members' ? 'visible' : 'hidden'}>
        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          <Members selected={selected} onSelect={setSelected} />
          <MemberTasks userId={selected} />
        </div>
      </Activity>
      <Activity mode={tab === 'workload' ? 'visible' : 'hidden'}>
        <Workload />
      </Activity>
    </>
  )
}

function Members({ selected, onSelect }: { selected: number | null; onSelect: (id: number) => void }) {
  const { data: users } = useSuspenseQuery(usersQuery())
  return (
    <Card title={`${users.length} members`}>
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" data-testid="member-list">
        {users.map((u) => (
          <MemberRow key={u.id} user={u} selected={selected === u.id} onSelect={() => onSelect(u.id)} />
        ))}
      </ul>
    </Card>
  )
}

function MemberRow({ user, selected, onSelect }: { user: User; selected: boolean; onSelect: () => void }) {
  const update = useUpdateUser()
  // React 19 useOptimistic: the select shows the new role immediately during the transition
  const [role, setOptimisticRole] = useOptimistic(user.role)
  const [, startTransition] = useTransition()
  return (
    <li
      className={`flex items-center gap-3 py-2 ${selected ? 'bg-brand-50/60 dark:bg-brand-500/10' : ''}`}
      data-testid="member-row"
    >
      <Avatar name={user.name} color={user.avatarColor} />
      <button className="min-w-0 flex-1 text-left" onClick={onSelect}>
        <div className="text-sm font-medium">
          {user.name} {!user.active && <span className="text-xs text-zinc-400">(inactive)</span>}
        </div>
        <div className="truncate text-xs text-zinc-500">
          {user.title} · {user.email}
        </div>
      </button>
      <Badge value={role} />
      <select
        className="input w-28"
        aria-label={`Role for ${user.name}`}
        value={role}
        disabled={user.role === 'owner'}
        onChange={(e) => {
          const next = e.target.value as Role
          startTransition(async () => {
            setOptimisticRole(next)
            await update.mutateAsync({ id: user.id, patch: { role: next } }).catch(() => {})
          })
        }}
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {titleCase(r)}
          </option>
        ))}
      </select>
    </li>
  )
}

function MemberTasks({ userId }: { userId: number | null }) {
  // dependent query: only runs once a member is selected
  const { data, isPending } = useQuery({ ...assigneeTasksQuery(userId ?? 0), enabled: userId !== null })
  if (userId === null)
    return (
      <Card title="Assigned tasks">
        <Empty>Select a member to see their tasks.</Empty>
      </Card>
    )
  return (
    <Card title="Assigned tasks">
      {isPending ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </div>
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

function Workload() {
  const { data = [] } = useQuery(workloadQuery())
  const max = Math.max(1, ...data.map((d) => d.open + d.done))
  return (
    <Card title="Open vs done tasks per member">
      <ul className="space-y-2" data-testid="workload">
        {data.map((d) => (
          <li key={d.userId} className="grid grid-cols-[160px_1fr_80px] items-center gap-3 text-sm">
            <span className="truncate">{d.name}</span>
            <div className="flex h-3 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div className="bg-amber-500" style={{ width: `${(d.open / max) * 100}%` }} />
              <div className="bg-emerald-500" style={{ width: `${(d.done / max) * 100}%` }} />
            </div>
            <span className="text-right text-xs text-zinc-500 tabular-nums">
              {d.open} open · {d.done}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
