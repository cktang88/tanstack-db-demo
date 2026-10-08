import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useDeferredValue, useMemo, useState } from 'react'
import { PROJECT_STATUSES, type ProjectStatus, type Task } from '../../shared/domain'
import { Avatar, Badge, ChipFilter, Empty, PageHeader } from '../components/ui'
import { date } from '../lib/format'
import { nextUpTasksQuery, projectStatsQuery, projectsQuery, usersQuery } from '../lib/queries'

const NO_TASKS = new Map<number, Task[]>()

export function ProjectsPage() {
  const { data: projects } = useSuspenseQuery(projectsQuery())
  const { data: users = [] } = useQuery(usersQuery())
  // progress comes from a separate SQL view endpoint; stitched together client-side
  const { data: stats = [] } = useQuery(projectStatsQuery())
  const statsById = useMemo(() => new Map(stats.map((s) => [s.projectId, s])), [stats])
  // "next up" per project: ONE query of every open task, grouped client-side
  const { data: nextUp = NO_TASKS } = useQuery(nextUpTasksQuery())
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<ProjectStatus[]>([])
  const deferredQ = useDeferredValue(q)

  const filtered = useMemo(
    () =>
      projects.filter(
        (p) =>
          (!deferredQ || p.name.toLowerCase().includes(deferredQ.toLowerCase())) &&
          (status.length === 0 || status.includes(p.status)),
      ),
    [projects, deferredQ, status],
  )

  return (
    <>
      <PageHeader title="Projects" description={`${projects.length} delivery projects across your accounts.`} />
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <input
          className="input max-w-xs"
          placeholder="Search projects…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search projects"
        />
        <ChipFilter label="Status" options={PROJECT_STATUSES} value={status} onChange={setStatus} />
      </div>
      {filtered.length === 0 ? (
        <Empty>No projects match.</Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="project-grid">
          {filtered.map((p) => {
            const owner = users.find((u) => u.id === p.ownerId)
            const st = statsById.get(p.id)
            const taskCount = st?.taskCount ?? 0
            const doneCount = st?.doneCount ?? 0
            const hours = Math.round((st?.minutesLogged ?? 0) / 60)
            const pct = taskCount ? Math.round((doneCount / taskCount) * 100) : 0
            return (
              <Link
                key={p.id}
                to="/projects/$projectId"
                params={{ projectId: p.id }}
                className="card block p-4 transition hover:border-brand-500/50 hover:shadow-md"
                data-testid="project-card"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-medium">{p.name}</h3>
                  <Badge value={p.status} />
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-zinc-500">{p.description}</p>
                <ul className="mt-3 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                  {(nextUp.get(p.id) ?? []).map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">→ {t.title}</span>
                      <Badge value={t.priority} />
                    </li>
                  ))}
                </ul>
                <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                  <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-zinc-500">
                  <span data-testid="project-progress">
                    {doneCount}/{taskCount} tasks · {pct}% · {hours}/{p.budgetHours}h
                  </span>
                  <span className="flex items-center gap-2">
                    {date(p.createdAt)}
                    {owner && <Avatar name={owner.name} color={owner.avatarColor} size={20} />}
                  </span>
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </>
  )
}
