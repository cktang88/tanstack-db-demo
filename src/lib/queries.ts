import { infiniteQueryOptions, keepPreviousData, mutationOptions, queryOptions } from '@tanstack/react-query'
import type {
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
  },
  invoices: {
    all: ['invoices'] as const,
    list: (p: InvoiceListParams) => [...keys.invoices.all, 'list', p] as const,
    byCustomer: (customerId: number) => [...keys.invoices.all, 'customer', customerId] as const,
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
    maxPages: 20,
  })

export const recentActivityQuery = () =>
  queryOptions({
    queryKey: keys.events.recent(),
    queryFn: ({ signal }) => api.get<CursorPage<ActivityEvent>>('/events/feed', { limit: 8 }, signal),
    select: (p) => p.data,
    // the dashboard "live" widget polls; polling pauses automatically when the tab is hidden
    refetchInterval: 10_000,
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
