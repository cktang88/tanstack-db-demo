import { infiniteQueryOptions, keepPreviousData, mutationOptions, queryOptions } from '@tanstack/react-query'
import type {
  Contact,
  CustomerBalance,
  CustomerHealth,
  CustomerTag,
  InvoiceLineItem,
  MrrSnapshot,
  Notification,
  Payment,
  Product,
  ProjectStats,
  RoleRow,
  Subscription,
  Tag,
  TaskComment,
  Team,
  TeamMember,
  TimeEntry,
  UsageDaily,
  ActivityEvent,
  BreakdownPoint,
  Customer,
  CursorPage,
  Invoice,
  OverviewMetrics,
  Page,
  Project,
  RevenuePoint,
  SignupPoint,
  Task,
  User,
} from '../../shared/domain'
import { api, type QueryParams } from './api'

// ----------------------------------------------------------------------------
// Query key factory. Every cache entry lives under a hierarchical key so we can
// invalidate whole subtrees (e.g. `keys.customers.all`) after mutations.
// ----------------------------------------------------------------------------
export const keys = {
  users: { all: ['users'] as const, list: () => [...keys.users.all, 'list'] as const },
  customers: {
    all: ['customers'] as const,
    lists: () => [...keys.customers.all, 'list'] as const,
    list: (p: CustomerListParams) => [...keys.customers.lists(), p] as const,
    detail: (id: number) => [...keys.customers.all, 'detail', id] as const,
    lookup: (q: string) => [...keys.customers.all, 'lookup', q] as const,
    byIds: (ids: readonly number[]) => [...keys.customers.all, 'by-ids', ids] as const,
  },
  invoices: {
    all: ['invoices'] as const,
    list: (p: InvoiceListParams) => [...keys.invoices.all, 'list', p] as const,
    byCustomer: (customerId: number) => [...keys.invoices.all, 'customer', customerId] as const,
    byIds: (ids: readonly number[]) => [...keys.invoices.all, 'by-ids', ids] as const,
  },
  projects: {
    all: ['projects'] as const,
    list: () => [...keys.projects.all, 'list'] as const,
    detail: (id: number) => [...keys.projects.all, 'detail', id] as const,
  },
  tasks: {
    all: ['tasks'] as const,
    byProject: (projectId: number) => [...keys.tasks.all, 'project', projectId] as const,
    byAssignee: (userId: number) => [...keys.tasks.all, 'assignee', userId] as const,
    stats: () => [...keys.tasks.all, 'stats'] as const,
  },
  events: {
    all: ['events'] as const,
    feed: (type?: string) => [...keys.events.all, 'feed', type ?? 'all'] as const,
    recent: () => [...keys.events.all, 'recent'] as const,
    customer: (customerId: number) => [...keys.events.all, 'customer', customerId] as const,
  },
  metrics: {
    all: ['metrics'] as const,
    overview: () => [...keys.metrics.all, 'overview'] as const,
    revenue: (months: number) => [...keys.metrics.all, 'revenue', months] as const,
    signups: (months: number) => [...keys.metrics.all, 'signups', months] as const,
    breakdown: (by: string) => [...keys.metrics.all, 'breakdown', by] as const,
    workload: () => [...keys.metrics.all, 'workload'] as const,
  },
}

export interface CustomerListParams {
  page: number
  pageSize: number
  sort?: string
  q?: string
  status?: string[]
  plan?: string[]
  country?: string[]
  ownerId?: number
}

export interface InvoiceListParams {
  page: number
  pageSize: number
  sort?: string
  q?: string
  status?: string[]
  customerId?: number
  issuedFrom?: string
  issuedTo?: string
}

const STALE = 30_000

/** Distinct ids, sorted (a stable query key for "these rows"). */
export const distinctIds = (ids: Iterable<number>) => [...new Set(ids)].sort((a, b) => a - b)
const indexById = <T extends { id: number }>(p: Page<T>) => new Map(p.data.map((r) => [r.id, r]))

// ----------------------------------------------------------------------------
// Users
// ----------------------------------------------------------------------------
export const usersQuery = () =>
  queryOptions({
    queryKey: keys.users.list(),
    queryFn: ({ signal }) => api.get<Page<User>>('/users', { limit: 1000, sort: 'name' }, signal),
    select: (p) => p.data,
    staleTime: 5 * 60_000,
  })

// ----------------------------------------------------------------------------
// Customers
// ----------------------------------------------------------------------------
export const customersListQuery = (p: CustomerListParams) =>
  queryOptions({
    queryKey: keys.customers.list(p),
    queryFn: ({ signal }) =>
      api.get<Page<Customer>>(
        '/customers',
        {
          page: p.page,
          pageSize: p.pageSize,
          sort: p.sort,
          q: p.q,
          status: p.status,
          plan: p.plan,
          country: p.country,
          ownerId: p.ownerId,
        } satisfies QueryParams,
        signal,
      ),
    // keep the previous page visible while the next one loads (no flashing table)
    placeholderData: keepPreviousData,
    staleTime: STALE,
  })

export const customerQuery = (id: number) =>
  queryOptions({
    queryKey: keys.customers.detail(id),
    queryFn: ({ signal }) => api.get<Customer>(`/customers/${id}`, undefined, signal),
    staleTime: STALE,
  })

/**
 * Batched lookup of the rows a table page references: ONE request
 * (`/customers?id=1,2,3`, an IN filter) instead of one per row. Each row also
 * seeds its detail cache entry, so following a link renders instantly.
 */
export const customersByIdsQuery = (ids: readonly number[]) =>
  queryOptions({
    queryKey: keys.customers.byIds(ids),
    queryFn: async ({ signal, client }) => {
      const page = await api.get<Page<Customer>>('/customers', { id: [...ids], limit: ids.length }, signal)
      for (const c of page.data)
        if (client.getQueryData(keys.customers.detail(c.id)) === undefined) client.setQueryData(keys.customers.detail(c.id), c)
      return page
    },
    select: indexById,
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  })

export const customerLookupQuery = (q: string) =>
  queryOptions({
    queryKey: keys.customers.lookup(q),
    queryFn: ({ signal }) => api.get<Page<Customer>>('/customers', { q, pageSize: 8, sort: 'company' }, signal),
    select: (p) => p.data,
    staleTime: STALE,
    placeholderData: keepPreviousData,
  })

// ----------------------------------------------------------------------------
// Invoices
// ----------------------------------------------------------------------------
export const invoicesListQuery = (p: InvoiceListParams) =>
  queryOptions({
    queryKey: keys.invoices.list(p),
    queryFn: ({ signal }) =>
      api.get<Page<Invoice>>(
        '/invoices',
        {
          page: p.page,
          pageSize: p.pageSize,
          sort: p.sort,
          q: p.q,
          status: p.status,
          customerId: p.customerId,
          'issuedAt[gte]': p.issuedFrom,
          'issuedAt[lte]': p.issuedTo && `${p.issuedTo}T23:59:59.999Z`,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
    staleTime: STALE,
  })

/** Batched invoice lookup (`/invoices?id=1,2,3`), see customersByIdsQuery. */
export const invoicesByIdsQuery = (ids: readonly number[]) =>
  queryOptions({
    queryKey: keys.invoices.byIds(ids),
    queryFn: ({ signal }) => api.get<Page<Invoice>>('/invoices', { id: [...ids], limit: ids.length }, signal),
    select: indexById,
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
    staleTime: STALE,
  })

export const customerInvoicesQuery = (customerId: number) =>
  queryOptions({
    queryKey: keys.invoices.byCustomer(customerId),
    queryFn: ({ signal }) => api.get<Page<Invoice>>('/invoices', { customerId, sort: '-issuedAt', limit: 500 }, signal),
    select: (p) => p.data,
    staleTime: STALE,
  })

// ----------------------------------------------------------------------------
// Projects & tasks
// ----------------------------------------------------------------------------
export const projectsQuery = () =>
  queryOptions({
    queryKey: keys.projects.list(),
    queryFn: ({ signal }) =>
      api.get<Page<Project & { taskCount: number; doneCount: number }>>('/projects', { limit: 1000, sort: 'name' }, signal),
    select: (p) => p.data,
    staleTime: STALE,
  })

export const projectQuery = (id: number) =>
  queryOptions({
    queryKey: keys.projects.detail(id),
    queryFn: ({ signal }) => api.get<Project>(`/projects/${id}`, undefined, signal),
    staleTime: STALE,
  })

export const projectTasksQuery = (projectId: number) =>
  queryOptions({
    queryKey: keys.tasks.byProject(projectId),
    queryFn: ({ signal }) => api.get<Page<Task>>('/tasks', { projectId, sort: 'position', limit: 1000 }, signal),
    select: (p) => p.data,
    staleTime: STALE,
  })

export const assigneeTasksQuery = (userId: number) =>
  queryOptions({
    queryKey: keys.tasks.byAssignee(userId),
    queryFn: ({ signal }) => api.get<Page<Task>>('/tasks', { assigneeId: userId, sort: 'dueDate', limit: 1000 }, signal),
    select: (p) => p.data,
    staleTime: STALE,
  })

// ----------------------------------------------------------------------------
// Activity
// ----------------------------------------------------------------------------
export const activityFeedQuery = (type?: string) =>
  infiniteQueryOptions({
    queryKey: keys.events.feed(type),
    queryFn: ({ pageParam, signal }) =>
      api.get<CursorPage<ActivityEvent>>('/events/feed', { cursor: pageParam, limit: 30, type }, signal),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextCursor,
    // no maxPages: without getPreviousPageParam, capping would drop the newest pages
  })

export const recentActivityQuery = () =>
  queryOptions({
    queryKey: keys.events.recent(),
    queryFn: ({ signal }) => api.get<CursorPage<ActivityEvent>>('/events/feed', { limit: 8 }, signal),
    select: (p) => p.data,
    // no polling: the SSE change feed invalidates ['events'] on every write
  })

export const customerActivityQuery = (customerId: number) =>
  queryOptions({
    queryKey: keys.events.customer(customerId),
    queryFn: ({ signal }) => api.get<Page<ActivityEvent>>('/events', { customerId, sort: '-createdAt', limit: 20 }, signal),
    select: (p) => p.data,
  })

// ----------------------------------------------------------------------------
// Metrics (server aggregations)
// ----------------------------------------------------------------------------
export const overviewQuery = () =>
  queryOptions({
    queryKey: keys.metrics.overview(),
    queryFn: ({ signal }) => api.get<OverviewMetrics>('/metrics/overview', undefined, signal),
    staleTime: STALE,
  })

export const revenueQuery = (months: number) =>
  queryOptions({
    queryKey: keys.metrics.revenue(months),
    queryFn: ({ signal }) => api.get<RevenuePoint[]>('/metrics/revenue', { months }, signal),
    staleTime: STALE,
  })

export const signupsQuery = (months: number) =>
  queryOptions({
    queryKey: keys.metrics.signups(months),
    queryFn: ({ signal }) => api.get<SignupPoint[]>('/metrics/signups', { months }, signal),
    staleTime: STALE,
  })

export const breakdownQuery = (by: 'plan' | 'country' | 'status') =>
  queryOptions({
    queryKey: keys.metrics.breakdown(by),
    queryFn: ({ signal }) => api.get<BreakdownPoint[]>('/metrics/breakdown', { by }, signal),
    staleTime: STALE,
  })

export const workloadQuery = () =>
  queryOptions({
    queryKey: keys.metrics.workload(),
    queryFn: ({ signal }) =>
      api.get<Array<{ userId: number; name: string; open: number; done: number }>>('/metrics/workload', undefined, signal),
    staleTime: STALE,
  })

export { mutationOptions }

// ----------------------------------------------------------------------------
// Generic resource lists (every table is exposed through the same grammar).
// Keys are [resource, 'list', params] so a whole resource can be invalidated.
// ----------------------------------------------------------------------------
export const resourceList = <T>(resource: string, params: QueryParams = {}, opts: { staleTime?: number } = {}) =>
  queryOptions({
    queryKey: [resource, 'list', params] as const,
    queryFn: ({ signal }) => api.get<Page<T>>(`/${resource}`, { limit: 1000, ...params }, signal),
    select: (p: Page<T>) => p.data,
    staleTime: opts.staleTime ?? STALE,
  })

export const resourcePage = <T>(resource: string, params: QueryParams) =>
  queryOptions({
    queryKey: [resource, 'page', params] as const,
    queryFn: ({ signal }) => api.get<Page<T>>(`/${resource}`, params, signal),
    placeholderData: keepPreviousData,
    staleTime: STALE,
  })

export const projectStatsQuery = () => resourceList<ProjectStats>('project-stats')
export const productsQuery = () => resourceList<Product>('products', { sort: 'id' }, { staleTime: 5 * 60_000 })
export const tagsQuery = () => resourceList<Tag>('tags', { sort: 'name' }, { staleTime: 5 * 60_000 })
export const teamsQuery = () => resourceList<Team>('teams', { sort: 'name' }, { staleTime: 5 * 60_000 })
export const teamMembersQuery = () => resourceList<TeamMember>('team-members')
export const rolesQuery = () => resourceList<RoleRow>('roles', { sort: 'rank' }, { staleTime: Infinity })
export const rolePermissionsQuery = () =>
  resourceList<{ id: string; roleId: string; permissionId: string }>('role-permissions', {}, { staleTime: Infinity })
export const permissionsQuery = () =>
  resourceList<{ id: string; description: string }>('permissions', {}, { staleTime: Infinity })

export const customerContactsQuery = (customerId: number) => resourceList<Contact>('contacts', { customerId, sort: '-isPrimary' })
export const customerTagsQuery = (customerId: number) => resourceList<CustomerTag>('customer-tags', { customerId })
export const customerSubscriptionsQuery = (customerId: number) =>
  resourceList<Subscription>('subscriptions', { customerId, sort: 'id' })
export const customerBalanceQuery = (customerId: number) =>
  queryOptions({
    queryKey: ['customer-balances', 'item', customerId],
    queryFn: ({ signal }) => api.get<CustomerBalance>(`/customer-balances/${customerId}`, undefined, signal).catch(() => null),
  })
export const customerHealthQuery = (customerId: number) =>
  queryOptions({
    queryKey: ['customer-health', 'item', customerId],
    queryFn: ({ signal }) => api.get<CustomerHealth>(`/customer-health/${customerId}`, undefined, signal).catch(() => null),
  })
export const customerUsageQuery = (customerId: number, metric = 'api_calls') =>
  resourceList<UsageDaily>('usage-daily', { customerId, metric, sort: 'day' })

export const invoiceLineItemsQuery = (invoiceId: number) => resourceList<InvoiceLineItem>('invoice-line-items', { invoiceId })
export const invoicePaymentsQuery = (invoiceId: number) => resourceList<Payment>('payments', { invoiceId, sort: 'receivedAt' })

export const taskCommentsQuery = (taskId: number) => resourceList<TaskComment>('task-comments', { taskId, sort: 'createdAt' })
export const taskTimeQuery = (taskId: number) => resourceList<TimeEntry>('time-entries', { taskId, sort: '-spentOn' })

export const mrrSnapshotsQuery = () => resourceList<MrrSnapshot>('mrr-snapshots', { sort: 'month' })
export const arAgingQuery = () =>
  queryOptions({
    queryKey: ['metrics', 'ar-aging'],
    queryFn: ({ signal }) =>
      api.get<Array<{ bucket: string; invoices: number; amount: number }>>('/metrics/ar-aging', undefined, signal),
    staleTime: STALE,
  })

export const notificationsQuery = () =>
  queryOptions({
    queryKey: ['notifications', 'list'],
    queryFn: ({ signal }) => api.get<Page<Notification>>('/notifications', { limit: 30, sort: '-createdAt' }, signal),
    select: (p) => p.data,
    // no polling: the SSE change feed invalidates ['notifications']
  })

export const sessionsQuery = () =>
  resourceList<{ id: number; userId: number; createdAt: string; expiresAt: string; userAgent: string | null }>('sessions')

// ----------------------------------------------------------------------------
// Pinned accounts, project "next up" (port of the TanStack DB branch features)
// ----------------------------------------------------------------------------

/**
 * Open + overdue invoices of some customers, in ONE request
 * (`/invoices?customerId=1,2,3&status=open,overdue`), summed per customer
 * client-side (gross: before partial payments).
 */
export const openInvoiceTotalsQuery = (customerIds: readonly number[]) =>
  queryOptions({
    queryKey: [...keys.invoices.all, 'open-by-customers', customerIds] as const,
    queryFn: ({ signal }) =>
      api.get<Page<Invoice>>('/invoices', { customerId: [...customerIds], status: ['open', 'overdue'], limit: 10_000 }, signal),
    select: (p) => {
      const totals = new Map<number, number>()
      for (const i of p.data) totals.set(i.customerId, (totals.get(i.customerId) ?? 0) + i.amount)
      return totals
    },
    enabled: customerIds.length > 0,
    placeholderData: keepPreviousData,
    staleTime: STALE,
  })

/** Up to `n` not-done tasks per project, by board position. */
export function nextUpByProject(tasks: readonly Task[], n = 3) {
  const out = new Map<number, Task[]>()
  for (const t of [...tasks].sort((a, b) => a.position - b.position || a.id - b.id)) {
    if (t.status === 'done') continue
    const list = out.get(t.projectId) ?? []
    if (list.length < n) out.set(t.projectId, [...list, t])
  }
  return out
}

/** Every open task in ONE request, grouped into each project's "next up" list. */
export const nextUpTasksQuery = () =>
  queryOptions({
    queryKey: [...keys.tasks.all, 'next-up'] as const,
    queryFn: ({ signal }) => api.get<Page<Task>>('/tasks', { 'status[neq]': 'done', sort: 'position', limit: 10_000 }, signal),
    select: (p) => nextUpByProject(p.data),
    staleTime: STALE,
  })
