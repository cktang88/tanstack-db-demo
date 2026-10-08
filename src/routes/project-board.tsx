import { useMutationState, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useActionState, useEffect, useMemo, useRef, useState, ViewTransition, type RefObject } from 'react'
import { TASK_PRIORITIES, TASK_STATUSES, type Project, type Task, type TaskStatus, type User } from '../../shared/domain'
import { TaskDialog } from '../components/TaskDialog'
import { Avatar, Badge, PageHeader } from '../components/ui'
import { useCan } from '../lib/auth'
import { date, field, titleCase } from '../lib/format'
import { useCreateTask, useDeleteTask, useUpdateProjectDescription, useUpdateTask, type NewTask } from '../lib/mutations'
import { projectQuery, projectTasksQuery, usersQuery } from '../lib/queries'
import { projectBoardRoute } from '../router'

export function ProjectBoardPage() {
  const { projectId } = projectBoardRoute.useParams()
  const { data: project } = useSuspenseQuery(projectQuery(projectId))
  const { data: tasks } = useSuspenseQuery(projectTasksQuery(projectId))
  const { data: users } = useSuspenseQuery(usersQuery())
  const { canEditProject } = useCan()
  const [assignee, setAssignee] = useState<number | 'all'>('all')
  const [openId, setOpenId] = useState<number | null>(null)
  // Drag & drop: the column records where a card was dropped and the card
  // (on dragend) moves itself, so every write to a task goes through that
  // task's own mutation scope and reaches the server in order.
  const dropTarget = useRef<TaskStatus | null>(null)

  // Pending creates are rendered "via the UI" from mutation state, in addition
  // to the optimistic cache entry — shows how many moving parts are involved.
  const pendingCreates = useMutationState({
    filters: { mutationKey: ['tasks', 'create'], status: 'pending' },
    select: (m) => m.state.variables as NewTask,
  })
  // per-card pending state: tasks with an update still in flight (or queued in their scope)
  const pendingUpdates = useMutationState({
    filters: { mutationKey: ['tasks', 'update'], status: 'pending' },
    select: (m) => (m.state.variables as { id: number }).id,
  })
  const savingIds = useMemo(() => new Set(pendingUpdates), [pendingUpdates])
  const saving = pendingCreates.length + savingIds.size

  const columns = useMemo(() => {
    const visible = tasks.filter((t) => assignee === 'all' || t.assigneeId === assignee)
    return TASK_STATUSES.map((status) => ({
      status,
      tasks: visible.filter((t) => t.status === status).sort((a, b) => a.position - b.position),
    }))
  }, [tasks, assignee])

  const done = tasks.filter((t) => t.status === 'done').length

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
      <DescriptionEditor projectId={project.id} value={project.description} editable={canEditProject(project)} />
      <TaskDialog
        task={tasks.find((t) => t.id === openId) ?? null}
        users={users}
        canAssign={canEditProject(project)}
        onClose={() => setOpenId(null)}
      />
      <div className="grid gap-4 lg:grid-cols-4" data-testid="board">
        {columns.map((col) => (
          <Column
            key={col.status}
            status={col.status}
            tasks={col.tasks}
            users={users}
            project={project}
            dropTarget={dropTarget}
            savingIds={savingIds}
            onOpen={(t) => setOpenId(t.id)}
          />
        ))}
      </div>
    </>
  )
}

function Column({
  status,
  tasks,
  users,
  project,
  dropTarget,
  savingIds,
  onOpen,
}: {
  status: TaskStatus
  tasks: Task[]
  users: User[]
  project: Project
  dropTarget: RefObject<TaskStatus | null>
  savingIds: ReadonlySet<number>
  onOpen: (t: Task) => void
}) {
  const { canEditProject } = useCan()
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
      onDrop={() => {
        setOver(false)
        dropTarget.current = status
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
          <ViewTransition key={t.id} name={`task-${t.id}`}>
            <TaskCard
              task={t}
              users={users}
              project={project}
              dropTarget={dropTarget}
              saving={savingIds.has(t.id)}
              onOpen={onOpen}
            />
          </ViewTransition>
        ))}
      </ul>
      {status === 'todo' && canEditProject(project) && <NewTaskForm projectId={project.id} />}
    </section>
  )
}

function TaskCard({
  task,
  users,
  project,
  dropTarget,
  saving,
  onOpen,
}: {
  task: Task
  users: User[]
  project: Project
  dropTarget: RefObject<TaskStatus | null>
  saving: boolean
  onOpen: (t: Task) => void
}) {
  const update = useUpdateTask(task.id)
  const del = useDeleteTask()
  const assignee = users.find((u) => u.id === task.assigneeId)
  const idx = TASK_STATUSES.indexOf(task.status)
  const optimistic = task.id < 0
  const pending = saving || optimistic
  // viewers / non-team members get a read-only card (the server would 403 and we'd roll back)
  const editable = useCan().canEditTask(task, project)
  return (
    <li
      draggable={!optimistic && editable}
      onDragStart={(e) => {
        dropTarget.current = null
        e.dataTransfer.setData('text/task', String(task.id))
      }}
      onDragEnd={() => {
        const status = dropTarget.current
        dropTarget.current = null
        if (status && status !== task.status) update.mutate({ id: task.id, patch: { status } })
      }}
      data-testid="task-card"
      data-pending={pending ? 'true' : undefined}
      className={`card group p-3 text-sm ${editable ? 'cursor-grab' : ''} ${optimistic ? 'opacity-60' : ''} ${pending ? 'ring-1 ring-amber-400/60' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <button className="text-left font-medium hover:text-brand-600" data-testid="task-title" onClick={() => onOpen(task)}>
          {task.title}
        </button>
        {editable && (
          <button
            className="text-xs text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-red-600"
            aria-label={`Delete ${task.title}`}
            onClick={() => del.mutate(task.id)}
            disabled={optimistic}
          >
            ✕
          </button>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Badge value={task.priority} />
          {task.dueDate && <span className="text-xs text-zinc-500">{date(task.dueDate)}</span>}
          {pending && <span className="text-xs text-amber-600">saving…</span>}
        </div>
        {assignee && <Avatar name={assignee.name} color={assignee.avatarColor} size={20} />}
      </div>
      <div className="mt-2 flex justify-between">
        <button
          className="btn-ghost px-1.5 py-0.5 text-xs"
          disabled={!editable || idx === 0 || optimistic}
          aria-label="Move left"
          onClick={() => update.mutate({ id: task.id, patch: { status: TASK_STATUSES[idx - 1]! } })}
        >
          ←
        </button>
        <button
          className="btn-ghost px-1.5 py-0.5 text-xs"
          disabled={!editable || idx === TASK_STATUSES.length - 1 || optimistic}
          aria-label="Move right"
          onClick={() => update.mutate({ id: task.id, patch: { status: TASK_STATUSES[idx + 1]! } })}
        >
          →
        </button>
      </div>
    </li>
  )
}

/**
 * Autosave: a controlled local draft, one PATCH per pause in typing (600 ms
 * debounce), optimistic in every cached copy of the project. Server values
 * (another tab, SSE) replace the draft only while nothing is queued or saving.
 */
function DescriptionEditor({ projectId, value, editable }: { projectId: number; value: string; editable: boolean }) {
  const qc = useQueryClient()
  const save = useUpdateProjectDescription(projectId)
  const [draft, setDraft] = useState(value)
  const [queued, setQueued] = useState<string | null>(null)
  const busy = queued !== null || save.isPending
  const [seen, setSeen] = useState(value)
  if (value !== seen) {
    setSeen(value)
    if (!busy) setDraft(value)
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<string | null>(null)
  const { mutate } = save // stable for the observer's lifetime
  // leaving the page while a save is still debouncing sends it right away
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      if (pending.current !== null) mutate(pending.current)
    },
    [mutate],
  )
  const onChange = (next: string) => {
    setDraft(next)
    setQueued(next)
    pending.current = next
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      pending.current = null
      setQueued(null)
      // a refused save rolls the cache back; show that (unless newer typing is queued)
      mutate(next, {
        onError: () => {
          const saved = qc.getQueryData(projectQuery(projectId).queryKey)
          if (saved && pending.current === null) setDraft(saved.description)
        },
      })
    }, 600)
  }
  return (
    <label className="mb-4 block">
      <span className="label flex items-center gap-2">
        Description <span className="text-amber-600">{busy ? 'saving…' : ''}</span>
      </span>
      <textarea
        className="input min-h-14"
        value={draft}
        readOnly={!editable}
        aria-label="Project description"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

function NewTaskForm({ projectId }: { projectId: number }) {
  const create = useCreateTask()
  // React 19 form action + useActionState for validation errors. React resets
  // the form after the action, so on a validation error the submitted values
  // come back as defaults (remounting via `key`: a reset <select> would
  // otherwise snap back to its mount-time option).
  type Draft = { error: string | null; title: string; priority: NewTask['priority']; attempt: number }
  const [{ error, title, priority, attempt }, action] = useActionState(
    (prev: Draft, form: FormData): Draft => {
      const title = field(form, 'title').trim()
      const priority = (field(form, 'priority') || 'medium') as NewTask['priority']
      if (title.length < 3) return { error: 'Title must be at least 3 characters', title, priority, attempt: prev.attempt + 1 }
      create.mutate({ projectId, title, status: 'todo', priority, assigneeId: null, dueDate: null })
      return { ...prev, error: null, title: '' }
    },
    { error: null, title: '', priority: 'medium', attempt: 0 },
  )
  return (
    <form key={attempt} action={action} className="mt-3 space-y-2">
      <input name="title" className="input" placeholder="New task…" aria-label="New task title" defaultValue={title} />
      <div className="flex gap-2">
        <select name="priority" className="input" defaultValue={priority} aria-label="Priority">
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
