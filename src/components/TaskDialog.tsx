import { field } from '../lib/format'
import { useMutationState, useQuery } from '@tanstack/react-query'
import { useActionState } from 'react'
import type { Task, User } from '../../shared/domain'
import { useCan } from '../lib/auth'
import { localToday, relative } from '../lib/format'
import { useAddComment, useDeleteTime, useLogTime, useUpdateTask } from '../lib/mutations'
import { taskCommentsQuery, taskTimeQuery } from '../lib/queries'
import { Avatar, Badge, Dialog } from './ui'

interface Props {
  task: Task | null
  users: User[]
  /** may (re)assign the task: only for those who can edit the project, not just the assignee */
  canAssign: boolean
  onClose: () => void
}

export function TaskDialog({ task, users, canAssign, onClose }: Props) {
  return (
    <Dialog open={!!task} onClose={onClose} title={task?.title ?? ''}>
      {task && <TaskBody task={task} users={users} canAssign={canAssign} />}
    </Dialog>
  )
}

function TaskBody({ task, users, canAssign }: { task: Task; users: User[]; canAssign: boolean }) {
  const { me, can, privileged } = useCan()
  const update = useUpdateTask(task.id)
  const byId = new Map(users.map((u) => [u.id, u]))
  return (
    <div className="space-y-5 text-sm" data-testid="task-dialog">
      <div className="flex flex-wrap items-center gap-2">
        <Badge value={task.status} />
        <Badge value={task.priority} />
        <label className="ml-auto flex items-center gap-2 text-xs text-zinc-500">
          Assignee
          <select
            className="input w-44"
            aria-label="Assignee"
            value={task.assigneeId ?? ''}
            disabled={!canAssign || task.id < 0}
            onChange={(e) =>
              update.mutate({ id: task.id, patch: { assigneeId: e.target.value ? Number(e.target.value) : null } })
            }
          >
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Comments taskId={task.id} byId={byId} meId={me.user.id} canComment={can('comments:write')} />
      <TimeLog
        taskId={task.id}
        byId={byId}
        meId={me.user.id}
        canLog={can('time:write')}
        // server: own entries only, unless owner/admin
        canDelete={(e) => can('time:write') && (privileged || e.userId === me.user.id)}
      />
    </div>
  )
}

function Comments({
  taskId,
  byId,
  meId,
  canComment,
}: {
  taskId: number
  byId: Map<number, User>
  meId: number
  canComment: boolean
}) {
  const { data: comments = [] } = useQuery(taskCommentsQuery(taskId))
  const add = useAddComment()
  // optimistic "via the UI": render pending comment variables until the refetch lands
  const pending = useMutationState({
    filters: { mutationKey: ['task-comments', 'create'], status: 'pending' },
    select: (m) => m.state.variables as { taskId: number; body: string },
  }).filter((v) => v.taskId === taskId)
  // the draft survives a failed post (React resets the form after the action)
  const [{ error, draft }, action] = useActionState(
    async (_: { error: string | null; draft: string }, f: FormData) => {
      const body = field(f, 'body').trim()
      if (!body) return { error: 'Comment cannot be empty', draft: '' }
      try {
        await add.mutateAsync({ taskId, body })
        return { error: null, draft: '' }
      } catch (e) {
        return { error: (e as Error).message, draft: body }
      }
    },
    { error: null, draft: '' },
  )
  return (
    <section>
      <h3 className="label">Discussion (append-only)</h3>
      <ul className="max-h-56 space-y-2 overflow-auto" data-testid="comments">
        {comments.map((c) => {
          const u = c.authorId ? byId.get(c.authorId) : undefined
          return (
            <li key={c.id} className="flex gap-2">
              {u && <Avatar name={u.name} color={u.avatarColor} size={22} />}
              <div>
                <div className="text-xs text-zinc-500">
                  {u?.name ?? 'Someone'} · {relative(c.createdAt)}
                </div>
                <div>{c.body}</div>
              </div>
            </li>
          )
        })}
        {pending.map((p, i) => {
          const u = byId.get(meId)
          return (
            <li key={`p${i}`} className="flex gap-2 opacity-60">
              {u && <Avatar name={u.name} color={u.avatarColor} size={22} />}
              <div>
                <div className="text-xs text-zinc-500">{u?.name ?? 'Someone'} · sending…</div>
                <div>{p.body}</div>
              </div>
            </li>
          )
        })}
        {comments.length + pending.length === 0 && <li className="text-zinc-500">No comments yet.</li>}
      </ul>
      {canComment && (
        <form action={action} className="mt-2 flex gap-2">
          <input name="body" className="input" placeholder="Write a comment…" aria-label="Comment" defaultValue={draft} />
          <button className="btn-secondary">Post</button>
        </form>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </section>
  )
}

type NewTimeEntry = { taskId: number; minutes: number; spentOn: string; billable: boolean; note: string }

function TimeLog({
  taskId,
  byId,
  meId,
  canLog,
  canDelete,
}: {
  taskId: number
  byId: Map<number, User>
  meId: number
  canLog: boolean
  canDelete: (e: { userId: number }) => boolean
}) {
  const { data: entries = [] } = useQuery(taskTimeQuery(taskId))
  const log = useLogTime()
  const del = useDeleteTime()
  // entries being logged are rendered from mutation state (dimmed) until the refetch lands
  const logging = useMutationState({
    filters: { mutationKey: ['time-entries', 'create'], status: 'pending' },
    select: (m) => m.state.variables as NewTimeEntry,
  }).filter((v) => v.taskId === taskId)
  const deleting = new Set(
    useMutationState({
      filters: { mutationKey: ['time-entries', 'delete'], status: 'pending' },
      select: (m) => m.state.variables as number,
    }),
  )
  // totals count what's being logged right away (and stop counting what's being deleted)
  const counted = [...logging, ...entries.filter((e) => !deleting.has(e.id))]
  const total = counted.reduce((s, e) => s + e.minutes, 0)
  const billable = counted.filter((e) => e.billable).reduce((s, e) => s + e.minutes, 0)
  return (
    <section>
      <h3 className="label">
        Time — {(total / 60).toFixed(1)}h total, {(billable / 60).toFixed(1)}h billable
      </h3>
      <ul className="max-h-40 space-y-1 overflow-auto" data-testid="time-entries">
        {logging.map((e, i) => (
          <li key={`p${i}`} className="flex items-center justify-between gap-2 opacity-60">
            <span>
              {e.spentOn} · {byId.get(meId)?.name ?? '?'} {!e.billable && <Badge value="non-billable" tone="zinc" />}
            </span>
            <span className="flex items-center gap-2 tabular-nums">{e.minutes}m</span>
          </li>
        ))}
        {entries.map((e) => (
          <li key={e.id} className={`flex items-center justify-between gap-2 ${deleting.has(e.id) ? 'opacity-60' : ''}`}>
            <span>
              {e.spentOn} · {byId.get(e.userId)?.name ?? '?'} {!e.billable && <Badge value="non-billable" tone="zinc" />}
            </span>
            <span className="flex items-center gap-2 tabular-nums">
              {e.minutes}m
              {canDelete(e) && (
                <button
                  className="text-xs text-zinc-400 hover:text-red-600"
                  aria-label="Delete time entry"
                  onClick={() => del.mutate(e.id)}
                >
                  ✕
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {canLog && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          action={(f) =>
            log.mutate({
              taskId,
              minutes: Number(f.get('minutes')),
              spentOn: field(f, 'spentOn'),
              billable: f.get('billable') === 'on',
              note: '',
            })
          }
        >
          <input name="minutes" type="number" min={1} max={1440} defaultValue={30} className="input w-20" aria-label="Minutes" />
          <input name="spentOn" type="date" defaultValue={localToday()} className="input w-36" aria-label="Date" />
          <label className="flex items-center gap-1 text-xs">
            <input name="billable" type="checkbox" defaultChecked /> billable
          </label>
          <button className="btn-secondary">Log time</button>
        </form>
      )}
    </section>
  )
}
