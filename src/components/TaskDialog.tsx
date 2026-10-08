import { and, count, eq, SchemaValidationError, sum, useLiveQuery } from '@tanstack/react-db'
import { useState, type FormEvent } from 'react'
import type { User } from '../../shared/domain'
import {
  commentsCollection,
  newId,
  projectsCollection,
  tasksCollection,
  timeEntriesCollection,
  usersCollection,
  type TaskRow,
} from '../db/collections'
import { useCan } from '../lib/auth'
import { field, relative } from '../lib/format'
import { toast } from '../lib/toast'
import { Avatar, Badge, Dialog } from './ui'

const today = () => new Date().toISOString().slice(0, 10)
const rollback = (title: string) => (e: Error) => toast.error(title, e.message)

export function TaskDialog({ taskId, onClose }: { taskId: number | null; onClose: () => void }) {
  const { data: task } = useLiveQuery({
    query: (q) =>
      taskId === null
        ? undefined
        : q
            .from({ t: tasksCollection })
            .where(({ t }) => eq(t.id, taskId))
            .findOne(),
  })
  return (
    <Dialog open={!!task} onClose={onClose} title={task?.title ?? ''}>
      {task && <TaskBody task={task} />}
    </Dialog>
  )
}

function TaskBody({ task }: { task: TaskRow }) {
  const { me, can, canEditTask, privileged } = useCan()
  const { data: users } = useLiveQuery({ query: (q) => q.from({ u: usersCollection }).orderBy(({ u }) => u.name) })
  const { data: project } = useLiveQuery({
    query: (q) =>
      q
        .from({ p: projectsCollection })
        .where(({ p }) => eq(p.id, task.projectId))
        .findOne(),
  })
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
            disabled={!canEditTask(project, task)}
            onChange={(e) =>
              tasksCollection
                .update(task.id, (d) => void (d.assigneeId = e.target.value ? Number(e.target.value) : null))
                .when('settled')
                .catch(rollback('Could not reassign — rolled back'))
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
  const { data: comments } = useLiveQuery({
    query: (q) =>
      q
        .from({ c: commentsCollection })
        .where(({ c }) => eq(c.taskId, taskId))
        .orderBy(({ c }) => c.createdAt)
        .orderBy(({ c }) => c.id),
  })
  // controlled + onSubmit (a form action would reset the input) so a rejected comment stays editable
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const post = (e: FormEvent) => {
    e.preventDefault()
    try {
      // append-only collection (insert handler only); the Effect Schema rejects empty bodies before render
      commentsCollection
        .insert({ id: newId(), taskId, authorId: meId, body: body.trim(), createdAt: new Date().toISOString() })
        .when('settled')
        .catch(rollback('Could not post comment — removed'))
      setBody('')
      setError(null)
    } catch (e) {
      if (e instanceof SchemaValidationError) return setError(e.issues[0]?.message ?? 'Invalid comment')
      throw e
    }
  }
  return (
    <section>
      <h3 className="label">Discussion (append-only)</h3>
      <ul className="max-h-56 space-y-2 overflow-auto" data-testid="comments">
        {comments.map((c) => {
          const u = c.authorId ? byId.get(c.authorId) : undefined
          return (
            <li key={c.id} className={`flex gap-2 ${c.$hasPendingWrites ? 'opacity-60' : ''}`}>
              {u && <Avatar name={u.name} color={u.avatarColor} size={22} />}
              <div>
                <div className="text-xs text-zinc-500">
                  {u?.name ?? 'Someone'} · {c.$hasPendingWrites ? 'sending…' : relative(c.createdAt)}
                </div>
                <div>{c.body}</div>
              </div>
            </li>
          )
        })}
        {comments.length === 0 && <li className="text-zinc-500">No comments yet.</li>}
      </ul>
      {canComment && (
        <form onSubmit={post} className="mt-2 flex gap-2">
          <input
            name="body"
            className="input"
            placeholder="Write a comment…"
            aria-label="Comment"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <button className="btn-secondary">Post</button>
        </form>
      )}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </section>
  )
}

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
  const { data: entries } = useLiveQuery({
    query: (q) =>
      q
        .from({ e: timeEntriesCollection })
        .where(({ e }) => eq(e.taskId, taskId))
        .orderBy(({ e }) => e.spentOn, 'desc')
        .orderBy(({ e }) => e.id, 'desc'),
  })
  // totals are live aggregates — they move the instant an entry is added or removed
  const { data: totals } = useLiveQuery({
    query: (q) =>
      q
        .from({ e: timeEntriesCollection })
        .where(({ e }) => eq(e.taskId, taskId))
        .select(({ e }) => ({ minutes: sum(e.minutes), n: count(e.id) }))
        .findOne(),
  })
  const { data: billable } = useLiveQuery({
    query: (q) =>
      q
        .from({ e: timeEntriesCollection })
        .where(({ e }) => and(eq(e.taskId, taskId), eq(e.billable, true)))
        .select(({ e }) => ({ minutes: sum(e.minutes) }))
        .findOne(),
  })
  return (
    <section>
      <h3 className="label">
        Time — {((totals?.minutes ?? 0) / 60).toFixed(1)}h total, {((billable?.minutes ?? 0) / 60).toFixed(1)}h billable
      </h3>
      <ul className="max-h-40 space-y-1 overflow-auto" data-testid="time-entries">
        {entries.map((e) => (
          <li key={e.id} className={`flex items-center justify-between gap-2 ${e.$hasPendingWrites ? 'opacity-60' : ''}`}>
            <span>
              {e.spentOn} · {byId.get(e.userId)?.name ?? '?'} {!e.billable && <Badge value="non-billable" tone="zinc" />}
            </span>
            <span className="flex items-center gap-2 tabular-nums">
              {e.minutes}m
              {canDelete(e) && (
                <button
                  className="text-xs text-zinc-400 hover:text-red-600"
                  aria-label="Delete time entry"
                  onClick={() =>
                    timeEntriesCollection.delete(e.id).when('settled').catch(rollback('Could not delete — restored'))
                  }
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
            void timeEntriesCollection
              .insert({
                id: newId(),
                taskId,
                userId: meId,
                minutes: Number(field(f, 'minutes')),
                spentOn: field(f, 'spentOn'),
                billable: f.get('billable') === 'on',
                note: '',
                createdAt: new Date().toISOString(),
              })
              .when('settled')
              .then(() => toast.success('Time logged'), rollback('Could not log time — removed'))
          }
        >
          <input name="minutes" type="number" min={1} max={1440} defaultValue={30} className="input w-20" aria-label="Minutes" />
          <input name="spentOn" type="date" defaultValue={today()} className="input w-36" aria-label="Date" />
          <label className="flex items-center gap-1 text-xs">
            <input name="billable" type="checkbox" defaultChecked /> billable
          </label>
          <button className="btn-secondary">Log time</button>
        </form>
      )}
    </section>
  )
}
