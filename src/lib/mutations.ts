import { useMutation, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import type { Customer, Invoice, Page, Payment, Project, Task, User } from '../../shared/domain'
import { api } from './api'
import { keys } from './queries'
import { invalidateEntities, mutating, type Entity } from './sync'
import { toast } from './toast'
import type { CustomerFormValues } from './validation'

// ----------------------------------------------------------------------------
// Helpers for the "classic" React Query optimistic-update dance.
// The same entity can live in many cache entries (paged lists with different
// filters, a detail entry, per-customer lists, ...). Every mutation has to
// find & patch all of them by hand, remember enough to roll back, and then
// invalidate whatever aggregates (metrics) might have changed.
//
// Concurrency rules (several optimistic writes can be in flight at once):
// - mutation keys start with the entity: ['customers', 'update'], ...
// - onSettled invalidates via invalidateEntities(), which skips entities that
//   still have *other* writes in flight; the last one to settle refetches.
// - updates roll back field by field (only fields still holding our value),
//   never by restoring a whole-cache snapshot that would wipe other writes.
// - writes to the same row share a mutation scope, so they reach the server
//   in order.
// ----------------------------------------------------------------------------

type Snapshot = Array<[QueryKey, unknown]>

async function snapshot(qc: QueryClient, ...prefixes: QueryKey[]): Promise<Snapshot> {
  await Promise.all(prefixes.map((queryKey) => qc.cancelQueries({ queryKey })))
  return prefixes.flatMap((queryKey) => qc.getQueriesData({ queryKey }))
}

function restore(qc: QueryClient, snap: Snapshot | undefined) {
  snap?.forEach(([key, data]) => qc.setQueryData(key, data))
}

/** Rows inside a cached `Page<T>`, `T[]` or `T`. */
function rowsOf<T extends { id: number }>(data: unknown): T[] {
  if (!data || typeof data !== 'object') return []
  if (Array.isArray(data)) return data as T[]
  if ('data' in data && Array.isArray(data.data)) return data.data as T[]
  return 'id' in data ? [data as T] : []
}

/** The currently cached version of some rows (to roll an optimistic patch back). */
function cachedRows<T extends { id: number }>(qc: QueryClient, prefix: QueryKey, ids: number[]) {
  const want = new Set(ids)
  const out = new Map<number, T>()
  for (const [, data] of qc.getQueriesData({ queryKey: prefix }))
    for (const row of rowsOf<T>(data)) if (want.has(row.id) && !out.has(row.id)) out.set(row.id, row)
  return out
}

/** Patch an entity inside every cached `Page<T>`, `T[]` or `T` under a key prefix. */
function patchEverywhere<T extends { id: number }>(qc: QueryClient, prefix: QueryKey, id: number, patch: (t: T) => T | null) {
  qc.setQueriesData({ queryKey: prefix }, (old: unknown): unknown => {
    if (!old || typeof old !== 'object') return old
    const patchList = (list: T[]) => list.flatMap((t) => (t.id === id ? (patch(t) ?? []) : [t]))
    if (Array.isArray(old)) return patchList(old as T[])
    if ('data' in old && Array.isArray(old.data)) {
      const page = old as Page<T>
      const data = patchList(page.data)
      return { ...page, data, total: page.total - (page.data.length - data.length) }
    }
    if ('id' in old && old.id === id) return patch(old as T) ?? undefined
    return old
  })
}

/** Apply `patch` optimistically to rows `ids`; returns what's needed to revert it. */
async function optimisticPatch<T extends { id: number }>(qc: QueryClient, prefix: QueryKey, ids: number[], patch: Partial<T>) {
  await qc.cancelQueries({ queryKey: prefix })
  const previous = cachedRows<T>(qc, prefix, ids)
  ids.forEach((id) => patchEverywhere<T>(qc, prefix, id, (t) => ({ ...t, ...patch })))
  return { prefix, previous, patch }
}

/**
 * Undo an optimistic patch, field by field, for the given rows: a field is
 * only reverted if it still holds the value we wrote, so a later concurrent
 * write to the same row (or other rows) survives our rollback.
 */
function revertPatch<T extends { id: number }>(
  qc: QueryClient,
  ctx: { prefix: QueryKey; previous: Map<number, T>; patch: Partial<T> } | undefined,
  ids?: number[],
) {
  if (!ctx) return
  for (const [id, prev] of ctx.previous) {
    if (ids && !ids.includes(id)) continue
    patchEverywhere<T>(qc, ctx.prefix, id, (cur) => {
      const next = { ...cur }
      for (const k of Object.keys(ctx.patch) as Array<keyof T>) if (cur[k] === ctx.patch[k]) next[k] = prev[k]
      return next
    })
  }
}

/** True when the calling mutation is the only write to `entity` still in flight. */
const lastWrite = (qc: QueryClient, entity: Entity) => mutating(qc, entity) === 1

/** Run one request per id; succeed if at least one did (partial success is reported, not thrown). */
async function settleEach<R>(ids: number[], fn: (id: number) => Promise<R>) {
  const results = await Promise.allSettled(ids.map(fn))
  const ok: Array<{ id: number; value: R }> = []
  const failed: Array<{ id: number; error: Error }> = []
  results.forEach((r, i) =>
    r.status === 'fulfilled' ? ok.push({ id: ids[i]!, value: r.value }) : failed.push({ id: ids[i]!, error: r.reason as Error }),
  )
  if (!ok.length && failed[0]) throw failed[0].error
  return { ok, failed }
}

const partialFailure = (what: string, total: number, failed: Array<{ error: Error }>) =>
  toast.error(`${what} ${total - failed.length} of ${total}`, `${failed.length} failed: ${failed[0]!.error.message}`)

const onError = (title: string) => (err: Error) => toast.error(title, err.message)

// ----------------------------------------------------------------------------
// Customers
// ----------------------------------------------------------------------------

// a customer write can change its subscriptions (churn cancels them), MRR, health and the feed
const CUSTOMER_WRITE: Entity[] = ['customers', 'subscriptions', 'events']

export function useCreateCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['customers', 'create'],
    mutationFn: (input: CustomerFormValues) => api.post<Customer>('/customers', input),
    onSuccess: (customer) => {
      // We cannot know which paged/filtered list the new row belongs to, so we
      // throw away every list + all metrics and refetch.
      qc.setQueryData(keys.customers.detail(customer.id), customer)
      toast.success('Customer created', customer.company)
    },
    onError: onError('Could not create customer'),
    onSettled: () => invalidateEntities(qc, CUSTOMER_WRITE, { self: 'customers' }),
  })
}

/** Pass the customer id so that edits of the same customer run serially, in order. */
export function useUpdateCustomer(customerId?: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['customers', 'update'],
    scope: customerId === undefined ? undefined : { id: `customer-${customerId}` },
    mutationFn: ({ id, patch }: { id: number; patch: Partial<CustomerFormValues> }) =>
      api.patch<Customer>(`/customers/${id}`, patch),
    onMutate: ({ id, patch }) => optimisticPatch<Customer>(qc, keys.customers.all, [id], patch as Partial<Customer>),
    onError: (err, _vars, ctx) => {
      revertPatch(qc, ctx)
      onError('Update failed — changes rolled back')(err)
    },
    onSuccess: (customer) => {
      // server-computed fields (mrr, updatedAt) — unless another write would be overwritten
      if (lastWrite(qc, 'customers')) patchEverywhere<Customer>(qc, keys.customers.all, customer.id, () => customer)
    },
    onSettled: () => invalidateEntities(qc, CUSTOMER_WRITE, { self: 'customers' }),
  })
}

export function useDeleteCustomers() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['customers', 'delete'],
    mutationFn: (ids: number[]) => settleEach(ids, (id) => api.delete(`/customers/${id}`)),
    onMutate: async (ids) => {
      const snap = await snapshot(qc, keys.customers.all)
      ids.forEach((id) => patchEverywhere<Customer>(qc, keys.customers.all, id, () => null))
      return { snap }
    },
    onError: (err, _ids, ctx) => {
      // Re-inserting rows into paged lists needs the snapshot; if other writes
      // are in flight the final invalidation brings the rows back instead.
      if (lastWrite(qc, 'customers')) restore(qc, ctx?.snap)
      onError('Archive failed — rows restored')(err)
    },
    onSuccess: ({ ok, failed }, ids, ctx) => {
      if (!failed.length) return toast.success(`Archived ${ids.length} customer${ids.length === 1 ? '' : 's'}`)
      if (lastWrite(qc, 'customers')) {
        restore(qc, ctx.snap)
        ok.forEach(({ id }) => patchEverywhere<Customer>(qc, keys.customers.all, id, () => null))
      }
      partialFailure('Archived', ids.length, failed)
    },
    onSettled: () => invalidateEntities(qc, [...CUSTOMER_WRITE, 'invoices', 'projects'], { self: 'customers' }),
  })
}

export function useBulkUpdateCustomers() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['customers', 'bulk-update'],
    mutationFn: ({ ids, patch }: { ids: number[]; patch: Partial<CustomerFormValues> }) =>
      settleEach(ids, (id) => api.patch<Customer>(`/customers/${id}`, patch)),
    onMutate: ({ ids, patch }) => optimisticPatch<Customer>(qc, keys.customers.all, ids, patch as Partial<Customer>),
    onError: (err, _v, ctx) => {
      revertPatch(qc, ctx)
      onError('Bulk update failed — rolled back')(err)
    },
    onSuccess: ({ ok, failed }, { ids }, ctx) => {
      // roll back only the rows the server refused
      revertPatch(
        qc,
        ctx,
        failed.map((f) => f.id),
      )
      if (lastWrite(qc, 'customers'))
        ok.forEach(({ value }) => patchEverywhere<Customer>(qc, keys.customers.all, value.id, () => value))
      if (failed.length) partialFailure('Updated', ids.length, failed)
      else toast.success(`Updated ${ok.length} customer${ok.length === 1 ? '' : 's'}`)
    },
    onSettled: () => invalidateEntities(qc, CUSTOMER_WRITE, { self: 'customers' }),
  })
}

// ----------------------------------------------------------------------------
// Invoices
// ----------------------------------------------------------------------------

const PAYMENT_WRITE: Entity[] = ['invoices', 'payments', 'customer-balances', 'events']

export function useMarkInvoicePaid() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['invoices', 'mark-paid'],
    // paying = appending a payment to the ledger for the outstanding remainder
    mutationFn: (id: number) => api.post(`/invoices/${id}/pay`, { method: 'card' }),
    onMutate: (id) => optimisticPatch<Invoice>(qc, keys.invoices.all, [id], { status: 'paid', paidAt: new Date().toISOString() }),
    onError: (err, _id, ctx) => {
      revertPatch(qc, ctx)
      onError('Could not mark invoice paid')(err)
    },
    onSettled: () => invalidateEntities(qc, PAYMENT_WRITE, { self: 'invoices' }),
  })
}

// ----------------------------------------------------------------------------
// Generic "call the API, then invalidate everything that might be affected".
// This is the honest default with TanStack Query once a write touches rows
// that live in many caches (e.g. a payment changes the invoice, the ledger,
// the balance rollup, health, MRR metrics and the activity feed).
// ----------------------------------------------------------------------------
export function useApiAction<V, R = unknown>(opts: {
  key: string[]
  fn: (v: V) => Promise<R>
  /** entities this write may change (see ENTITY_KEYS); key[0] should be the entity written */
  invalidate: readonly Entity[]
  success?: string | ((r: R, v: V) => string)
  error: string
}) {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: opts.key,
    mutationFn: opts.fn,
    onSuccess: (r, v) => opts.success && toast.success(typeof opts.success === 'function' ? opts.success(r, v) : opts.success),
    onError: onError(opts.error),
    onSettled: () => invalidateEntities(qc, opts.invalidate, { self: opts.key[0] }),
  })
}

const BILLING_KEYS: Entity[] = [...PAYMENT_WRITE, 'subscriptions', 'customers', 'mrr-snapshots']

export const useRecordPayment = () =>
  useApiAction({
    key: ['payments', 'create'],
    fn: (v: { invoiceId: number; amount?: number; method: 'card' | 'ach' | 'wire' }) => api.post<Payment>('/payments', v),
    invalidate: BILLING_KEYS,
    success: 'Payment recorded',
    error: 'Could not record payment',
  })

export const useVoidInvoice = () =>
  useApiAction({
    key: ['invoices', 'void'],
    fn: (id: number) => api.patch(`/invoices/${id}`, { status: 'void' }),
    invalidate: BILLING_KEYS,
    success: 'Invoice voided',
    error: 'Could not void invoice',
  })

export const useAddSubscription = () =>
  useApiAction({
    key: ['subscriptions', 'create'],
    fn: (v: { customerId: number; productId: number; quantity: number }) => api.post('/subscriptions', v),
    invalidate: BILLING_KEYS,
    success: 'Add-on added',
    error: 'Could not add subscription',
  })

export const useUpdateSubscription = () =>
  useApiAction({
    key: ['subscriptions', 'update'],
    fn: ({ id, patch }: { id: number; patch: { quantity?: number; status?: string } }) =>
      api.patch(`/subscriptions/${id}`, patch),
    invalidate: BILLING_KEYS,
    success: 'Subscription updated',
    error: 'Could not update subscription',
  })

export const useAddContact = () =>
  useApiAction({
    key: ['contacts', 'create'],
    fn: (v: { customerId: number; name: string; email: string; title: string; isPrimary: boolean }) => api.post('/contacts', v),
    invalidate: ['contacts', 'events'],
    success: 'Contact added',
    error: 'Could not add contact',
  })

export const useDeleteContact = () =>
  useApiAction({
    key: ['contacts', 'delete'],
    fn: (id: number) => api.delete(`/contacts/${id}`),
    invalidate: ['contacts', 'events'],
    error: 'Could not remove contact',
  })

export const useTagCustomer = () =>
  useApiAction({
    key: ['customer-tags', 'create'],
    fn: (v: { customerId: number; tagId: number }) => api.post('/customer-tags', v),
    invalidate: ['customer-tags', 'events'],
    error: 'Could not tag customer',
  })

export const useUntagCustomer = () =>
  useApiAction({
    key: ['customer-tags', 'delete'],
    fn: (id: string) => api.delete(`/customer-tags/${id}`),
    invalidate: ['customer-tags', 'events'],
    error: 'Could not remove tag',
  })

export const useAddComment = () =>
  useApiAction({
    key: ['task-comments', 'create'],
    fn: (v: { taskId: number; body: string }) => api.post('/task-comments', v),
    invalidate: ['task-comments', 'notifications', 'events'],
    error: 'Could not post comment',
  })

export const useLogTime = () =>
  useApiAction({
    key: ['time-entries', 'create'],
    fn: (v: { taskId: number; minutes: number; spentOn: string; billable: boolean; note: string }) =>
      api.post('/time-entries', v),
    invalidate: ['time-entries'],
    success: 'Time logged',
    error: 'Could not log time',
  })

export const useDeleteTime = () =>
  useApiAction({
    key: ['time-entries', 'delete'],
    fn: (id: number) => api.delete(`/time-entries/${id}`),
    invalidate: ['time-entries'],
    error: 'Could not delete time entry',
  })

export const useMarkNotificationsRead = () =>
  useApiAction({
    key: ['notifications', 'read'],
    fn: (id: number | 'all') =>
      id === 'all'
        ? api.post('/notifications/read-all', {})
        : api.patch(`/notifications/${id}`, { readAt: new Date().toISOString() }),
    invalidate: ['notifications'],
    error: 'Could not update notifications',
  })

export const useTeamMembership = () =>
  useApiAction({
    key: ['team-members', 'toggle'],
    fn: (v: { teamId: number; userId: number; member: boolean }) =>
      v.member
        ? api.delete(`/team-members/${v.teamId}:${v.userId}`)
        : api.post('/team-members', { teamId: v.teamId, userId: v.userId }),
    invalidate: ['team-members', 'events'],
    error: 'Could not change membership',
  })

export const useUpdateProduct = () =>
  useApiAction({
    key: ['products', 'update'],
    fn: ({ id, patch }: { id: number; patch: { unitPrice?: number; active?: boolean; name?: string } }) =>
      api.patch(`/products/${id}`, patch),
    invalidate: ['products', 'events'],
    success: 'Product updated',
    error: 'Could not update product',
  })

export const useRunJob = () =>
  useApiAction({
    key: ['jobs'],
    fn: (job: 'mark-overdue' | 'rebuild-mrr') => api.post<Record<string, number>>(`/jobs/${job}`, {}),
    invalidate: BILLING_KEYS,
    success: (r, job) => `${job} done (${JSON.stringify(r)})`,
    error: 'Job failed',
  })

export const useRevokeSession = () =>
  useApiAction({
    key: ['sessions', 'delete'],
    fn: (id: number) => api.delete(`/sessions/${id}`),
    invalidate: ['sessions'],
    error: 'Could not revoke session',
  })

// ----------------------------------------------------------------------------
// Tasks
// ----------------------------------------------------------------------------

export type NewTask = Pick<Task, 'projectId' | 'title' | 'status' | 'priority' | 'assigneeId' | 'dueDate'>

// tasks also feed project cards, project-stats and the workload chart (see ENTITY_KEYS)
const TASK_WRITE: Entity[] = ['tasks', 'events']
let nextTempId = -1

export function useCreateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['tasks', 'create'],
    mutationFn: (input: NewTask) => api.post<Task>('/tasks', input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.tasks.all })
      const temp: Task = {
        ...input,
        id: nextTempId--,
        position: Number.MAX_SAFE_INTEGER,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      const append = (old: Page<Task> | undefined) => (old ? { ...old, data: [...old.data, temp], total: old.total + 1 } : old)
      qc.setQueryData<Page<Task>>(keys.tasks.byProject(input.projectId), append)
      if (input.assigneeId) qc.setQueryData<Page<Task>>(keys.tasks.byAssignee(input.assigneeId), append)
      return { tempId: temp.id }
    },
    onError: (err, _v, ctx) => {
      if (ctx) patchEverywhere<Task>(qc, keys.tasks.all, ctx.tempId, () => null)
      onError('Could not create task')(err)
    },
    // swap the placeholder for the real row right away (no flash while the lists refetch)
    onSuccess: (task, _v, ctx) => patchEverywhere<Task>(qc, keys.tasks.all, ctx.tempId, () => task),
    onSettled: () => invalidateEntities(qc, TASK_WRITE, { self: 'tasks' }),
  })
}

/** Pass the task id so that writes to the same task run serially, in order. */
export function useUpdateTask(taskId?: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['tasks', 'update'],
    scope: taskId === undefined ? undefined : { id: `task-${taskId}` },
    mutationFn: ({ id, patch }: { id: number; patch: Partial<Task> }) => api.patch<Task>(`/tasks/${id}`, patch),
    onMutate: ({ id, patch }) => optimisticPatch<Task>(qc, keys.tasks.all, [id], patch),
    onError: (err, _v, ctx) => {
      revertPatch(qc, ctx)
      onError('Task update failed — rolled back')(err)
    },
    onSuccess: (task) => {
      if (lastWrite(qc, 'tasks')) patchEverywhere<Task>(qc, keys.tasks.all, task.id, () => task)
    },
    onSettled: () => invalidateEntities(qc, TASK_WRITE, { self: 'tasks' }),
  })
}

export function useDeleteTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['tasks', 'delete'],
    mutationFn: (id: number) => api.delete(`/tasks/${id}`),
    onMutate: async (id) => {
      const snap = await snapshot(qc, keys.tasks.all)
      patchEverywhere<Task>(qc, keys.tasks.all, id, () => null)
      return { snap }
    },
    onError: (err, _v, ctx) => {
      // with other task writes in flight the final invalidation restores the card instead
      if (lastWrite(qc, 'tasks')) restore(qc, ctx?.snap)
      onError('Could not delete task')(err)
    },
    onSettled: () => invalidateEntities(qc, TASK_WRITE, { self: 'tasks' }),
  })
}

// ----------------------------------------------------------------------------
// Users
// ----------------------------------------------------------------------------

/** Pass the user id so that writes to the same user run serially, in order. */
export function useUpdateUser(userId?: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['users', 'update'],
    scope: userId === undefined ? undefined : { id: `user-${userId}` },
    mutationFn: ({ id, patch }: { id: number; patch: Partial<User> }) => api.patch<User>(`/users/${id}`, patch),
    onMutate: ({ id, patch }) => optimisticPatch<User>(qc, keys.users.all, [id], patch),
    onError: (err, _v, ctx) => {
      revertPatch(qc, ctx)
      onError('Could not update teammate')(err)
    },
    // 'users' also covers /auth/me, in case you edited yourself
    onSettled: () => invalidateEntities(qc, ['users', 'events'], { self: 'users' }),
  })
}

// ----------------------------------------------------------------------------
// Project board & team (port-3): description autosave, staged reassignment
// ----------------------------------------------------------------------------

/** Autosaved project description: optimistic in every cached project entry, serialized per project. */
export function useUpdateProjectDescription(projectId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['projects', 'update', 'description'],
    scope: { id: `project-${projectId}` },
    mutationFn: (description: string) => api.patch<Project>(`/projects/${projectId}`, { description }),
    onMutate: (description) => optimisticPatch<Project>(qc, keys.projects.all, [projectId], { description }),
    onError: (err, _v, ctx) => {
      revertPatch(qc, ctx)
      onError('Could not save description')(err)
    },
    onSettled: () => invalidateEntities(qc, ['projects', 'events'], { self: 'projects' }),
  })
}

/** A previewed reassignment: every open task of `fromId` goes to `toId`. */
export interface Reassignment {
  fromId: number
  toId: number
  taskIds: number[]
}

/** The open tasks a reassignment would move (always fresh: it is about to be written). */
export const fetchOpenTaskIds = (qc: QueryClient, assigneeId: number) =>
  qc
    .fetchQuery({
      queryKey: [...keys.tasks.all, 'open-ids', assigneeId],
      queryFn: ({ signal }) =>
        api.get<Page<Task>>('/tasks', { 'assigneeId[eq]': assigneeId, 'status[neq]': 'done', limit: 10000 }, signal),
      staleTime: 0,
    })
    .then((p) => p.data.map((t) => t.id))

/**
 * Save a reassignment as ONE atomic `POST /api/batch`. The mutation stays
 * pending until the refetch of tasks/workload/project-stats has landed, so a
 * view overlaying its variables never flashes the old numbers.
 */
export function useReassignTasks() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['tasks', 'reassign'],
    mutationFn: ({ toId, taskIds }: Reassignment) =>
      api.post('/batch', {
        ops: taskIds.map((id) => ({ entity: 'tasks', op: 'update', id, data: { assigneeId: toId } })),
      }),
    onSuccess: (_r, { taskIds }) => toast.success(`Reassigned ${taskIds.length} tasks`),
    onError: onError('Reassignment failed — rolled back'),
    onSettled: () => invalidateEntities(qc, TASK_WRITE, { self: 'tasks' }),
  })
}
