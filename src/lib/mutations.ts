import { useMutation, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import type { Customer, Invoice, Page, Payment, Task, User } from '../../shared/domain'
import { api } from './api'
import { keys } from './queries'
import { toast } from './toast'
import type { CustomerFormValues } from './validation'

// ----------------------------------------------------------------------------
// Helpers for the "classic" React Query optimistic-update dance.
// The same entity can live in many cache entries (paged lists with different
// filters, a detail entry, per-customer lists, ...). Every mutation has to
// find & patch all of them by hand, snapshot them for rollback, and then
// invalidate whatever aggregates (metrics) might have changed.
// ----------------------------------------------------------------------------

type Snapshot = Array<[QueryKey, unknown]>

async function snapshot(qc: QueryClient, ...prefixes: QueryKey[]): Promise<Snapshot> {
  await Promise.all(prefixes.map((queryKey) => qc.cancelQueries({ queryKey })))
  return prefixes.flatMap((queryKey) => qc.getQueriesData({ queryKey }))
}

function restore(qc: QueryClient, snap: Snapshot | undefined) {
  snap?.forEach(([key, data]) => qc.setQueryData(key, data))
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

const onError = (title: string) => (err: Error) => toast.error(title, err.message)

// ----------------------------------------------------------------------------
// Customers
// ----------------------------------------------------------------------------

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
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.customers.lists() }),
        qc.invalidateQueries({ queryKey: keys.metrics.all }),
        qc.invalidateQueries({ queryKey: keys.events.all }),
      ]),
  })
}

export function useUpdateCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['customers', 'update'],
    // updates to the same customer run serially, in order
    scope: { id: 'customer-update' },
    mutationFn: ({ id, patch }: { id: number; patch: Partial<CustomerFormValues> }) =>
      api.patch<Customer>(`/customers/${id}`, patch),
    onMutate: async ({ id, patch }) => {
      const snap = await snapshot(qc, keys.customers.all)
      patchEverywhere<Customer>(qc, keys.customers.all, id, (c) => ({ ...c, ...patch, updatedAt: new Date().toISOString() }))
      return { snap }
    },
    onError: (err, _vars, ctx) => {
      restore(qc, ctx?.snap)
      onError('Update failed — changes rolled back')(err)
    },
    onSuccess: (customer) => {
      patchEverywhere<Customer>(qc, keys.customers.all, customer.id, () => customer)
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.customers.lists() }),
        qc.invalidateQueries({ queryKey: keys.metrics.all }),
        qc.invalidateQueries({ queryKey: keys.events.all }),
      ]),
  })
}

export function useDeleteCustomers() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['customers', 'delete'],
    mutationFn: (ids: number[]) => Promise.all(ids.map((id) => api.delete(`/customers/${id}`))),
    onMutate: async (ids) => {
      const snap = await snapshot(qc, keys.customers.all)
      ids.forEach((id) => patchEverywhere<Customer>(qc, keys.customers.all, id, () => null))
      return { snap }
    },
    onError: (err, _ids, ctx) => {
      restore(qc, ctx?.snap)
      onError('Delete failed — rows restored')(err)
    },
    onSuccess: (_r, ids) => toast.success(`Deleted ${ids.length} customer${ids.length === 1 ? '' : 's'}`),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.customers.all }),
        qc.invalidateQueries({ queryKey: keys.invoices.all }),
        qc.invalidateQueries({ queryKey: keys.projects.all }),
        qc.invalidateQueries({ queryKey: keys.metrics.all }),
        qc.invalidateQueries({ queryKey: keys.events.all }),
      ]),
  })
}

export function useBulkUpdateCustomers() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['customers', 'bulk-update'],
    mutationFn: ({ ids, patch }: { ids: number[]; patch: Partial<CustomerFormValues> }) =>
      Promise.all(ids.map((id) => api.patch<Customer>(`/customers/${id}`, patch))),
    onMutate: async ({ ids, patch }) => {
      const snap = await snapshot(qc, keys.customers.all)
      ids.forEach((id) => patchEverywhere<Customer>(qc, keys.customers.all, id, (c) => ({ ...c, ...patch })))
      return { snap }
    },
    onError: (err, _v, ctx) => {
      restore(qc, ctx?.snap)
      onError('Bulk update failed — rolled back')(err)
    },
    onSuccess: (rows) => toast.success(`Updated ${rows.length} customers`),
    onSettled: () =>
      Promise.all([qc.invalidateQueries({ queryKey: keys.customers.all }), qc.invalidateQueries({ queryKey: keys.metrics.all })]),
  })
}

// ----------------------------------------------------------------------------
// Invoices
// ----------------------------------------------------------------------------

export function useMarkInvoicePaid() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['invoices', 'mark-paid'],
    // paying = appending a payment to the ledger for the outstanding remainder
    mutationFn: (id: number) => api.post(`/invoices/${id}/pay`, { method: 'card' }),
    onMutate: async (id) => {
      const snap = await snapshot(qc, keys.invoices.all)
      patchEverywhere<Invoice>(qc, keys.invoices.all, id, (i) => ({ ...i, status: 'paid', paidAt: new Date().toISOString() }))
      return { snap }
    },
    onError: (err, _id, ctx) => {
      restore(qc, ctx?.snap)
      onError('Could not mark invoice paid')(err)
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.invoices.all }),
        qc.invalidateQueries({ queryKey: ['payments'] }),
        qc.invalidateQueries({ queryKey: ['customer-balances'] }),
        qc.invalidateQueries({ queryKey: ['customer-health'] }),
        qc.invalidateQueries({ queryKey: keys.metrics.all }),
        qc.invalidateQueries({ queryKey: keys.events.all }),
      ]),
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
  invalidate: ReadonlyArray<readonly unknown[]>
  success?: string | ((r: R, v: V) => string)
  error: string
}) {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: opts.key,
    mutationFn: opts.fn,
    onSuccess: (r, v) => opts.success && toast.success(typeof opts.success === 'function' ? opts.success(r, v) : opts.success),
    onError: onError(opts.error),
    onSettled: () => Promise.all(opts.invalidate.map((queryKey) => qc.invalidateQueries({ queryKey: [...queryKey] }))),
  })
}

const BILLING_KEYS = [
  ['invoices'],
  ['payments'],
  ['customer-balances'],
  ['customer-health'],
  ['subscriptions'],
  ['customers'],
  ['mrr-snapshots'],
  ['metrics'],
  ['events'],
] as const

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
    invalidate: [['contacts']],
    success: 'Contact added',
    error: 'Could not add contact',
  })

export const useDeleteContact = () =>
  useApiAction({
    key: ['contacts', 'delete'],
    fn: (id: number) => api.delete(`/contacts/${id}`),
    invalidate: [['contacts']],
    error: 'Could not remove contact',
  })

export const useTagCustomer = () =>
  useApiAction({
    key: ['customer-tags', 'create'],
    fn: (v: { customerId: number; tagId: number }) => api.post('/customer-tags', v),
    invalidate: [['customer-tags']],
    error: 'Could not tag customer',
  })

export const useUntagCustomer = () =>
  useApiAction({
    key: ['customer-tags', 'delete'],
    fn: (id: string) => api.delete(`/customer-tags/${id}`),
    invalidate: [['customer-tags']],
    error: 'Could not remove tag',
  })

export const useAddComment = () =>
  useApiAction({
    key: ['task-comments', 'create'],
    fn: (v: { taskId: number; body: string }) => api.post('/task-comments', v),
    invalidate: [['task-comments'], ['notifications'], ['events']],
    error: 'Could not post comment',
  })

export const useLogTime = () =>
  useApiAction({
    key: ['time-entries', 'create'],
    fn: (v: { taskId: number; minutes: number; spentOn: string; billable: boolean; note: string }) =>
      api.post('/time-entries', v),
    invalidate: [['time-entries'], ['project-stats']],
    success: 'Time logged',
    error: 'Could not log time',
  })

export const useDeleteTime = () =>
  useApiAction({
    key: ['time-entries', 'delete'],
    fn: (id: number) => api.delete(`/time-entries/${id}`),
    invalidate: [['time-entries'], ['project-stats']],
    error: 'Could not delete time entry',
  })

export const useMarkNotificationsRead = () =>
  useApiAction({
    key: ['notifications', 'read'],
    fn: (id: number | 'all') =>
      id === 'all'
        ? api.post('/notifications/read-all', {})
        : api.patch(`/notifications/${id}`, { readAt: new Date().toISOString() }),
    invalidate: [['notifications']],
    error: 'Could not update notifications',
  })

export const useTeamMembership = () =>
  useApiAction({
    key: ['team-members', 'toggle'],
    fn: (v: { teamId: number; userId: number; member: boolean }) =>
      v.member
        ? api.delete(`/team-members/${v.teamId}:${v.userId}`)
        : api.post('/team-members', { teamId: v.teamId, userId: v.userId }),
    invalidate: [['team-members'], ['auth']],
    error: 'Could not change membership',
  })

export const useUpdateProduct = () =>
  useApiAction({
    key: ['products', 'update'],
    fn: ({ id, patch }: { id: number; patch: { unitPrice?: number; active?: boolean; name?: string } }) =>
      api.patch(`/products/${id}`, patch),
    invalidate: [['products']],
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
    invalidate: [['sessions']],
    error: 'Could not revoke session',
  })

// ----------------------------------------------------------------------------
// Tasks
// ----------------------------------------------------------------------------

export type NewTask = Pick<Task, 'projectId' | 'title' | 'status' | 'priority' | 'assigneeId' | 'dueDate'>

const taskPrefixes = [keys.tasks.all] as const

export function useCreateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['tasks', 'create'],
    mutationFn: (input: NewTask) => api.post<Task>('/tasks', input),
    onMutate: async (input) => {
      const snap = await snapshot(qc, ...taskPrefixes)
      const temp: Task = {
        ...input,
        id: -Date.now(),
        position: Number.MAX_SAFE_INTEGER,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      qc.setQueryData<Page<Task>>(keys.tasks.byProject(input.projectId), (old) =>
        old ? { ...old, data: [...old.data, temp], total: old.total + 1 } : old,
      )
      if (input.assigneeId)
        qc.setQueryData<Page<Task>>(keys.tasks.byAssignee(input.assigneeId), (old) =>
          old ? { ...old, data: [...old.data, temp], total: old.total + 1 } : old,
        )
      return { snap }
    },
    onError: (err, _v, ctx) => {
      restore(qc, ctx?.snap)
      onError('Could not create task')(err)
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.tasks.all }),
        qc.invalidateQueries({ queryKey: keys.projects.all }),
        qc.invalidateQueries({ queryKey: keys.metrics.all }),
      ]),
  })
}

export function useUpdateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['tasks', 'update'],
    scope: { id: 'tasks' },
    mutationFn: ({ id, patch }: { id: number; patch: Partial<Task> }) => api.patch<Task>(`/tasks/${id}`, patch),
    onMutate: async ({ id, patch }) => {
      const snap = await snapshot(qc, ...taskPrefixes)
      patchEverywhere<Task>(qc, keys.tasks.all, id, (t) => ({ ...t, ...patch }))
      return { snap }
    },
    onError: (err, _v, ctx) => {
      restore(qc, ctx?.snap)
      onError('Task update failed — rolled back')(err)
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.tasks.all }),
        qc.invalidateQueries({ queryKey: keys.projects.all }),
        qc.invalidateQueries({ queryKey: keys.metrics.all }),
      ]),
  })
}

export function useDeleteTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['tasks', 'delete'],
    mutationFn: (id: number) => api.delete(`/tasks/${id}`),
    onMutate: async (id) => {
      const snap = await snapshot(qc, ...taskPrefixes)
      patchEverywhere<Task>(qc, keys.tasks.all, id, () => null)
      return { snap }
    },
    onError: (err, _v, ctx) => {
      restore(qc, ctx?.snap)
      onError('Could not delete task')(err)
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: keys.tasks.all }),
        qc.invalidateQueries({ queryKey: keys.projects.all }),
        qc.invalidateQueries({ queryKey: keys.metrics.all }),
      ]),
  })
}

// ----------------------------------------------------------------------------
// Users
// ----------------------------------------------------------------------------

export function useUpdateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: ['users', 'update'],
    mutationFn: ({ id, patch }: { id: number; patch: Partial<User> }) => api.patch<User>(`/users/${id}`, patch),
    onMutate: async ({ id, patch }) => {
      const snap = await snapshot(qc, keys.users.all)
      patchEverywhere<User>(qc, keys.users.all, id, (u) => ({ ...u, ...patch }))
      return { snap }
    },
    onError: (err, _v, ctx) => {
      restore(qc, ctx?.snap)
      onError('Could not update teammate')(err)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.users.all }),
  })
}
