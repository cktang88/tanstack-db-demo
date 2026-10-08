import { useMutation, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import type { Customer, Invoice, Page, Task, User } from '../../shared/domain'
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
    mutationFn: (id: number) => api.patch<Invoice>(`/invoices/${id}`, { status: 'paid' }),
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
        qc.invalidateQueries({ queryKey: keys.metrics.all }),
        qc.invalidateQueries({ queryKey: keys.events.all }),
      ]),
  })
}

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
