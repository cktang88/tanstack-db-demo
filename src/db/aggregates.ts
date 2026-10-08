import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import type { BreakdownPoint, OverviewMetrics, Plan, ProductAdoption, RevenuePoint, SignupPoint } from '../../shared/domain'
import { api, type QueryParams } from '../lib/api'
import { queryClient } from './collections'

// Aggregates over the big tables come from the server.
//
// Customers, invoices, subscriptions and payments are on-demand collections:
// the client only ever holds the windows its live queries asked for, so a
// local COUNT/SUM over them would be a COUNT/SUM over whatever happens to be
// loaded. Totals of a filtered list (`?limit=0&sum=`) and the dashboard
// metrics (`/metrics/*`) are plain TanStack Query queries on the same
// QueryClient instead, kept fresh by the change feed (see live.ts). Local
// live-query aggregates remain wherever the data is bounded: a customer's
// own invoices and payments, tasks, a page window, the selection, the pins.

const STALE = 60_000

export const metricsKey = ['metrics'] as const
export const totalsKey = ['totals'] as const

export const overviewQuery = () =>
  queryOptions({
    queryKey: [...metricsKey, 'overview'],
    queryFn: ({ signal }) => api.get<OverviewMetrics>('/metrics/overview', undefined, signal),
    staleTime: STALE,
  })

export const revenueQuery = (months: number) =>
  queryOptions({
    queryKey: [...metricsKey, 'revenue', months],
    queryFn: ({ signal }) => api.get<RevenuePoint[]>('/metrics/revenue', { months }, signal),
    staleTime: STALE,
    placeholderData: keepPreviousData,
  })

export const signupsQuery = (months: number) =>
  queryOptions({
    queryKey: [...metricsKey, 'signups', months],
    queryFn: ({ signal }) => api.get<SignupPoint[]>('/metrics/signups', { months }, signal),
    staleTime: STALE,
  })

export const breakdownQuery = (by: 'plan' | 'country' | 'status', plan?: Plan) =>
  queryOptions({
    queryKey: [...metricsKey, 'breakdown', by, plan ?? 'all'],
    queryFn: ({ signal }) => api.get<BreakdownPoint[]>('/metrics/breakdown', { by, plan }, signal),
    staleTime: STALE,
    placeholderData: keepPreviousData,
  })

export const arAgingQuery = () =>
  queryOptions({
    queryKey: [...metricsKey, 'ar-aging'],
    queryFn: ({ signal }) =>
      api.get<Array<{ bucket: string; invoices: number; amount: number }>>('/metrics/ar-aging', undefined, signal),
    staleTime: STALE,
  })

/** live subscriptions per product, over every customer */
export const productAdoptionQuery = () =>
  queryOptions({
    queryKey: [...metricsKey, 'product-adoption'],
    queryFn: ({ signal }) => api.get<ProductAdoption[]>('/metrics/product-adoption', undefined, signal),
    select: (rows) => new Map(rows.map((r) => [r.productId, r])),
    staleTime: STALE,
  })

export interface ListTotal {
  total: number
  sums: Record<string, number>
}

/**
 * Count (and totals) of every row matching a list's filters: `?limit=0`
 * returns no rows, just `total` and the `sum=` fields over all matches.
 */
export const listTotalQuery = (resource: string, params: QueryParams, sum?: string) =>
  queryOptions({
    queryKey: [...totalsKey, resource, params, sum ?? null],
    queryFn: async ({ signal }): Promise<ListTotal> => {
      const page = await api.get<{ total: number; sums?: Record<string, number> }>(
        `/${resource}`,
        { ...params, limit: 0, ...(sum && { sum }) },
        signal,
      )
      return { total: page.total, sums: page.sums ?? {} }
    },
    staleTime: STALE,
    // keep the previous numbers on screen while a new filter's totals load
    placeholderData: keepPreviousData,
  })

/**
 * Which server aggregates a change to a resource can move. (Archiving a
 * customer hides its invoices, payments and subscriptions from every list and
 * metric, hence the wide fan-out of `customers`.)
 */
const MOVES: Record<string, ReadonlyArray<readonly unknown[]>> = {
  customers: [metricsKey, [...totalsKey, 'customers'], [...totalsKey, 'invoices'], [...totalsKey, 'payments']],
  invoices: [
    [...metricsKey, 'overview'],
    [...metricsKey, 'ar-aging'],
    [...totalsKey, 'invoices'],
  ],
  payments: [
    [...metricsKey, 'overview'],
    [...metricsKey, 'ar-aging'],
    [...metricsKey, 'revenue'],
    [...totalsKey, 'payments'],
  ],
  'customer-balances': [[...metricsKey, 'overview']],
  subscriptions: [[...metricsKey, 'product-adoption']],
  tasks: [[...metricsKey, 'overview']],
  'audit-log': [[...totalsKey, 'audit-log']],
}

const pending = new Set<string>()
let timer: ReturnType<typeof setTimeout> | undefined
/**
 * A change to `entity` happened (SSE, or our own committed write): re-read the
 * active metrics and totals it can move once the burst is over (debounced);
 * inactive ones are marked stale and refetch when next used.
 */
export function aggregatesChanged(entity: string) {
  if (!MOVES[entity]) return
  pending.add(entity)
  clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    const keys = new Map([...pending].flatMap((e) => MOVES[e]!).map((k) => [JSON.stringify(k), k]))
    pending.clear()
    for (const queryKey of keys.values()) void queryClient.invalidateQueries({ queryKey: [...queryKey] })
  }, 250)
}
