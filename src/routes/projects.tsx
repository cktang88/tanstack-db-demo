import { and, caseWhen, count, eq, ilike, inArray, not, sum, toArray, useLiveQuery } from '@tanstack/react-db'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { PROJECT_STATUSES, type ProjectStatus } from '../../shared/domain'
import { Avatar, Badge, ChipFilter, Empty, PageHeader } from '../components/ui'
import { projectsCollection, tasksCollection, usersCollection } from '../db/collections'
import { date } from '../lib/format'

export function ProjectsPage() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<ProjectStatus[]>([])

  // One live query: projects ⨝ owner ⨝ (tasks GROUP BY project) + a nested
  // "next up" list per project via `includes`. Progress bars move the instant a
  // task is moved on any board — no project re-fetch, no invalidation.
  const { data: projects } = useLiveQuery({
    query: (qb) => {
      const progress = qb
        .from({ t: tasksCollection })
        .groupBy(({ t }) => t.projectId)
        .select(({ t }) => ({
          projectId: t.projectId,
          total: count(t.id),
          done: sum(caseWhen(eq(t.status, 'done'), 1, 0)),
        }))
      let base = qb
        .from({ p: projectsCollection })
        .leftJoin({ u: usersCollection }, ({ p, u }) => eq(p.ownerId, u.id))
        .leftJoin({ s: progress }, ({ p, s }) => eq(p.id, s.projectId))
      if (q || status.length)
        base = base.where(({ p }) =>
          q && status.length
            ? and(ilike(p.name, `%${q}%`), inArray(p.status, status))
            : q
              ? ilike(p.name, `%${q}%`)
              : inArray(p.status, status),
        )
      return base
        .orderBy(({ p }) => p.name)
        .select(({ p, u, s }) => ({
          ...p,
          ownerName: u?.name,
          ownerColor: u?.avatarColor,
          total: s?.total,
          done: s?.done,
          nextUp: toArray(
            qb
              .from({ t: tasksCollection })
              .where(({ t }) => and(eq(t.projectId, p.id), not(eq(t.status, 'done'))))
              .orderBy(({ t }) => t.position)
              .limit(3)
              .select(({ t }) => ({ id: t.id, title: t.title, priority: t.priority })),
          ),
        }))
    },
  })

  return (
    <>
      <PageHeader title="Projects" description={`${projects.length} delivery projects — progress computed live from tasks.`} />
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
      {projects.length === 0 ? (
        <Empty>No projects match.</Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="project-grid">
          {projects.map((p) => {
            const total = p.total ?? 0
            const done = p.done ?? 0
            const pct = total ? Math.round((done / total) * 100) : 0
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
                  {p.nextUp.map((t) => (
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
                    {done}/{total} tasks · {pct}%
                  </span>
                  <span className="flex items-center gap-2">
                    {date(p.createdAt)}
                    {p.ownerName && <Avatar name={p.ownerName} color={p.ownerColor} size={20} />}
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
