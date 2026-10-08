import { useMutationState, useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useActionState, useMemo, useRef, useState, ViewTransition, type RefObject } from 'react'
import { TASK_PRIORITIES, TASK_STATUSES, type Task, type TaskStatus, type User } from '../../shared/domain'
import { TaskDialog } from '../components/TaskDialog'
import { Avatar, Badge, PageHeader } from '../components/ui'
import { date, titleCase } from '../lib/format'
import { useCreateTask, useDeleteTask, useUpdateTask, type NewTask } from '../lib/mutations'
import { projectQuery, projectTasksQuery, usersQuery } from '../lib/queries'
import { projectBoardRoute } from '../router'

export function ProjectBoardPage() {
  const { projectId } = projectBoardRoute.useParams()
  const { data: project } = useSuspenseQuery(projectQuery(projectId))
  const { data: tasks } = useSuspenseQuery(projectTasksQuery(projectId))
  const { data: users } = useSuspenseQuery(usersQuery())
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
            / {done}/{tasks.length} done{pendingCreates.length > 0 && ` · saving ${pendingCreates.length}…`}
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
      <TaskDialog task={tasks.find((t) => t.id === openId) ?? null} users={users} onClose={() => setOpenId(null)} />
      <div className="grid gap-4 lg:grid-cols-4" data-testid="board">
        {columns.map((col) => (
          <Column
            key={col.status}
            status={col.status}
            tasks={col.tasks}
            users={users}
            projectId={projectId}
            dropTarget={dropTarget}
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
  projectId,
  dropTarget,
  onOpen,
}: {
  status: TaskStatus
  tasks: Task[]
  users: User[]
  projectId: number
  dropTarget: RefObject<TaskStatus | null>
  onOpen: (t: Task) => void
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
            <TaskCard task={t} users={users} dropTarget={dropTarget} onOpen={onOpen} />
          </ViewTransition>
        ))}
      </ul>
      {status === 'todo' && <NewTaskForm projectId={projectId} />}
    </section>
  )
}

function TaskCard({
  task,
  users,
  dropTarget,
  onOpen,
}: {
  task: Task
  users: User[]
  dropTarget: RefObject<TaskStatus | null>
  onOpen: (t: Task) => void
}) {
  const update = useUpdateTask(task.id)
  const del = useDeleteTask()
  const assignee = users.find((u) => u.id === task.assigneeId)
  const idx = TASK_STATUSES.indexOf(task.status)
  const optimistic = task.id < 0
  return (
    <li
      draggable={!optimistic}
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
      className={`card group cursor-grab p-3 text-sm ${optimistic ? 'opacity-60' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <button className="text-left font-medium hover:text-brand-600" data-testid="task-title" onClick={() => onOpen(task)}>
          {task.title}
        </button>
        <button
          className="text-xs text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-red-600"
          aria-label={`Delete ${task.title}`}
          onClick={() => del.mutate(task.id)}
          disabled={optimistic}
        >
          ✕
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Badge value={task.priority} />
          {task.dueDate && <span className="text-xs text-zinc-500">{date(task.dueDate)}</span>}
        </div>
        {assignee && <Avatar name={assignee.name} color={assignee.avatarColor} size={20} />}
      </div>
      <div className="mt-2 flex justify-between">
        <button
          className="btn-ghost px-1.5 py-0.5 text-xs"
          disabled={idx === 0 || optimistic}
          aria-label="Move left"
          onClick={() => update.mutate({ id: task.id, patch: { status: TASK_STATUSES[idx - 1]! } })}
        >
          ←
        </button>
        <button
          className="btn-ghost px-1.5 py-0.5 text-xs"
          disabled={idx === TASK_STATUSES.length - 1 || optimistic}
          aria-label="Move right"
          onClick={() => update.mutate({ id: task.id, patch: { status: TASK_STATUSES[idx + 1]! } })}
        >
          →
        </button>
      </div>
    </li>
  )
}

function NewTaskForm({ projectId }: { projectId: number }) {
  const create = useCreateTask()
  // React 19 form action + useActionState for validation errors
  const [error, action] = useActionState((_prev: string | null, form: FormData) => {
    const title = (form.get('title') as string | null)?.trim() ?? ''
    if (title.length < 3) return 'Title must be at least 3 characters'
    create.mutate({
      projectId,
      title,
      status: 'todo',
      priority: (form.get('priority') as NewTask['priority']) ?? 'medium',
      assigneeId: null,
      dueDate: null,
    })
    return null
  }, null)
  return (
    <form action={action} className="mt-3 space-y-2">
      <input name="title" className="input" placeholder="New task…" aria-label="New task title" />
      <div className="flex gap-2">
        <select name="priority" className="input" defaultValue="medium" aria-label="Priority">
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
