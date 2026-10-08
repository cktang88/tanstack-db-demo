import {
  and,
  debounceStrategy,
  eq,
  SchemaValidationError,
  useLiveQuery,
  useLiveSuspenseQuery,
  usePacedMutations,
} from '@tanstack/react-db'
import { Link } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { TASK_PRIORITIES, TASK_STATUSES, type TaskStatus } from '../../shared/domain'
import { TaskDialog } from '../components/TaskDialog'
import { Avatar, Badge, PageHeader } from '../components/ui'
import { newId, persist, projectsCollection, tasksCollection, usersCollection, type TaskRow } from '../db/collections'
import { useCan } from '../lib/auth'
import { date, titleCase } from '../lib/format'
import { toast } from '../lib/toast'
import { projectBoardRoute } from '../router'

const onRollback = (title: string) => (e: Error) => toast.error(title, e.message)

export function ProjectBoardPage() {
  const { projectId } = projectBoardRoute.useParams()
  const { data: project } = useLiveSuspenseQuery({
    query: (q) =>
      q
        .from({ p: projectsCollection })
        .where(({ p }) => eq(p.id, projectId))
        .findOne(),
  })
  const { canEditProject, canEditTask } = useCan()
  const [assignee, setAssignee] = useState<number | 'all'>('all')
  const [openId, setOpenId] = useState<number | null>(null)
  const { data: users } = useLiveQuery({ query: (q) => q.from({ u: usersCollection }).orderBy(({ u }) => u.name) })
  // tasks for this project ⨝ assignee, filtered by the (indexed) projectId
  const { data: tasks } = useLiveQuery({
    query: (q) =>
      q
        .from({ t: tasksCollection })
        .leftJoin({ u: usersCollection }, ({ t, u }) => eq(t.assigneeId, u.id))
        .where(({ t }) =>
          assignee === 'all' ? eq(t.projectId, projectId) : and(eq(t.projectId, projectId), eq(t.assigneeId, assignee)),
        )
        .orderBy(({ t }) => t.position)
        .orderBy(({ t }) => t.id)
        .select(({ t, u }) => ({ ...t, assigneeName: u?.name, assigneeColor: u?.avatarColor })),
  })

  if (!project)
    return (
      <div className="card mx-auto mt-10 max-w-md p-6 text-center" role="alert">
        Not found
      </div>
    )

  // same row-level rules the server enforces: project editors manage the board, assignees move their own cards
  const editable = canEditProject(project)
  const canMove = (t: { assigneeId: number | null }) => canEditTask(project, t)
  const done = tasks.filter((t) => t.status === 'done').length
  const saving = tasks.filter((t) => t.$hasPendingWrites).length

  return (
    <>
      <PageHeader
        title={project.name}
        description={
          <>
            <Link to="/projects" className="text-brand-600 hover:underline">
              Projects
            </Link>{' '}
            / {done}/{tasks.length} done{saving > 0 && ` · saving ${saving}…`}
          </>
        }
        actions={
          <select
            className="input w-48"
            aria-label="Filter by assignee"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          >
            <option value="all">All assignees</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        }
      />
      <DescriptionEditor projectId={project.id} value={project.description} editable={editable} />
      <TaskDialog taskId={openId} onClose={() => setOpenId(null)} />
      <div className="grid gap-4 lg:grid-cols-4" data-testid="board">
        {TASK_STATUSES.map((status) => (
          <Column
            key={status}
            status={status}
            tasks={tasks.filter((t) => t.status === status)}
            projectId={projectId}
            onOpen={setOpenId}
            editable={editable}
            canMove={canMove}
          />
        ))}
      </div>
    </>
  )
}

/** Autosave with a debounced paced mutation: instant local echo, one PATCH after typing stops. */
function DescriptionEditor({ projectId, value, editable }: { projectId: number; value: string; editable: boolean }) {
  const save = usePacedMutations<string>({
    onMutate: (description) => projectsCollection.update(projectId, (d) => void (d.description = description)),
    mutationFn: async ({ transaction }) => persist(transaction.mutations),
    strategy: debounceStrategy({ wait: 600 }),
  })
  const { data: pending } = useLiveQuery({
    query: (q) =>
      q
        .from({ p: projectsCollection })
        .where(({ p }) => eq(p.id, projectId))
        .select(({ p }) => ({ id: p.id, pending: p.$hasPendingWrites }))
        .findOne(),
  })
  return (
    <label className="mb-4 block">
      <span className="label flex items-center gap-2">
        Description <span className="text-amber-600">{pending?.pending ? 'saving…' : ''}</span>
      </span>
      <textarea
        className="input min-h-14"
        value={value}
        readOnly={!editable}
        aria-label="Project description"
        onChange={(e) => save(e.target.value).when('settled').catch(onRollback('Could not save description'))}
      />
    </label>
  )
}

type BoardTask = TaskRow & { assigneeName?: string; assigneeColor?: string; $hasPendingWrites?: boolean }

function Column({
  status,
  tasks,
  projectId,
  onOpen,
  editable,
  canMove,
}: {
  status: TaskStatus
  tasks: BoardTask[]
  projectId: number
  onOpen: (id: number) => void
  editable: boolean
  canMove: (t: { assigneeId: number | null }) => boolean
}) {
  const [over, setOver] = useState(false)
  return (
    <section
      aria-label={titleCase(status)}
      data-testid={`column-${status}`}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        const task = tasksCollection.get(Number(e.dataTransfer.getData('text/task')))
        if (task && canMove(task)) moveTask(task.id, status)
      }}
      className={`flex min-h-64 flex-col rounded-xl border p-3 ${over ? 'border-brand-500 bg-brand-50/50 dark:bg-brand-500/5' : 'border-zinc-200 bg-zinc-100/50 dark:border-zinc-800 dark:bg-zinc-900/50'}`}
    >
      <h2 className="mb-3 flex items-center justify-between text-sm font-semibold">
        {titleCase(status)}
        <span className="rounded-full bg-zinc-200 px-2 text-xs dark:bg-zinc-800" data-testid="column-count">
          {tasks.length}
        </span>
      </h2>
      <ul className="flex flex-1 flex-col gap-2">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} onOpen={onOpen} canMove={canMove(t)} canDelete={editable} />
        ))}
      </ul>
      {status === 'todo' && editable && <NewTaskForm projectId={projectId} />}
    </section>
  )
}

function moveTask(id: number, status: TaskStatus) {
  tasksCollection
    .update(id, (d) => {
      d.status = status
      d.updatedAt = new Date().toISOString()
    })
    .when('settled')
    .catch(onRollback('Task update failed — rolled back'))
}

function TaskCard({
  task,
  onOpen,
  canMove,
  canDelete,
}: {
  task: BoardTask
  onOpen: (id: number) => void
  canMove: boolean
  canDelete: boolean
}) {
  const idx = TASK_STATUSES.indexOf(task.status)
  return (
    <li
      draggable={canMove}
      onDragStart={(e) => e.dataTransfer.setData('text/task', String(task.id))}
      data-testid="task-card"
      data-pending={task.$hasPendingWrites ? 'true' : undefined}
      className={`card group p-3 text-sm ${canMove ? 'cursor-grab' : ''} ${task.$hasPendingWrites ? 'ring-1 ring-amber-400/60' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <button className="text-left font-medium hover:text-brand-600" data-testid="task-title" onClick={() => onOpen(task.id)}>
          {task.title}
        </button>
        {canDelete && (
          <button
            className="text-xs text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-red-600"
            aria-label={`Delete ${task.title}`}
            // the server refuses (409) tasks that have comments: the optimistic delete rolls back by itself
            onClick={() => tasksCollection.delete(task.id).when('settled').catch(onRollback('Could not delete task — restored'))}
          >
            ✕
          </button>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Badge value={task.priority} />
          {task.dueDate && <span className="text-xs text-zinc-500">{date(task.dueDate)}</span>}
          {task.$hasPendingWrites && <span className="text-xs text-amber-600">saving…</span>}
        </div>
        {task.assigneeName && <Avatar name={task.assigneeName} color={task.assigneeColor} size={20} />}
      </div>
      <div className="mt-2 flex justify-between">
        <button
          className="btn-ghost px-1.5 py-0.5 text-xs"
          disabled={!canMove || idx === 0}
          aria-label="Move left"
          onClick={() => moveTask(task.id, TASK_STATUSES[idx - 1]!)}
        >
          ←
        </button>
        <button
          className="btn-ghost px-1.5 py-0.5 text-xs"
          disabled={!canMove || idx === TASK_STATUSES.length - 1}
          aria-label="Move right"
          onClick={() => moveTask(task.id, TASK_STATUSES[idx + 1]!)}
        >
          →
        </button>
      </div>
    </li>
  )
}

function NewTaskForm({ projectId }: { projectId: number }) {
  // controlled + onSubmit (not a form action, which resets the form) so a rejected title stays editable
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<TaskRow['priority']>('medium')
  const [error, setError] = useState<string | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const now = new Date().toISOString()
    try {
      // The collection's Effect Schema validates this synchronously before it renders.
      tasksCollection
        .insert({
          id: newId(),
          projectId,
          title: title.trim(),
          status: 'todo',
          priority,
          assigneeId: null,
          dueDate: null,
          position: Date.now(),
          createdAt: now,
          updatedAt: now,
        })
        .when('settled')
        .catch(onRollback('Could not create task — removed'))
      setTitle('')
      setError(null)
    } catch (e) {
      if (e instanceof SchemaValidationError) return setError(e.issues[0]?.message ?? 'Invalid task')
      throw e
    }
  }
  return (
    <form onSubmit={submit} className="mt-3 space-y-2">
      <input
        name="title"
        className="input"
        placeholder="New task…"
        aria-label="New task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="flex gap-2">
        <select
          name="priority"
          className="input"
          value={priority}
          onChange={(e) => setPriority(e.target.value as TaskRow['priority'])}
          aria-label="Priority"
        >
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {titleCase(p)}
            </option>
          ))}
        </select>
        <button className="btn-primary">Add</button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  )
}
