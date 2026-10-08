import type { Mutation, QueryClient } from '@tanstack/react-query'
import type { Customer } from '../../shared/domain'
import { money } from './format'
import { keys } from './queries'
import { toast } from './toast'

// ----------------------------------------------------------------------------
// Live alerts: toast when a customer *becomes* churned or crosses $20k MRR,
// whoever made the change (this tab, another tab, the server).
//
// With TanStack Query there is no query to subscribe to for "rows entering a
// result", so we compare every server version of a customer we get to see —
// rows pushed over SSE, and the results of our own customer mutations —
// against the version we had before, and fire on transitions only. Nothing
// fires for data that merely loads.
// ----------------------------------------------------------------------------

/** $20k MRR, in cents */
export const BIG_ACCOUNT_MRR = 2_000_000

type CustomerState = Pick<Customer, 'id' | 'company' | 'status' | 'mrr'>
export type CustomerAlert = { kind: 'churned' | 'big-account'; customer: CustomerState }

const isChurned = (c: CustomerState) => c.status === 'churned'
const isBig = (c: CustomerState) => c.mrr > BIG_ACCOUNT_MRR

/** Alerts raised by a customer going from `before` to `after` (`before` undefined: a brand-new row). */
export function customerAlerts(before: CustomerState | undefined, after: CustomerState): CustomerAlert[] {
  const out: CustomerAlert[] = []
  if (isChurned(after) && !(before && isChurned(before))) out.push({ kind: 'churned', customer: after })
  if (isBig(after) && !(before && isBig(before))) out.push({ kind: 'big-account', customer: after })
  return out
}

export function showCustomerAlert({ kind, customer }: CustomerAlert) {
  if (kind === 'churned') toast.info(`⚠ ${customer.company} churned`, 'Detected from server changes')
  else toast.success(`🎉 ${customer.company} is now a $20k+ MRR account`, money(customer.mrr))
}

const isCustomer = (v: unknown): v is CustomerState =>
  !!v && typeof v === 'object' && 'id' in v && 'company' in v && 'status' in v && 'mrr' in v

/** Rows inside a cached `Page<T>`, `T[]` or `T`. */
function rowsOf(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return []
  if (Array.isArray(data)) return data
  if ('data' in data && Array.isArray(data.data)) return data.data
  return [data]
}

/** The most recently fetched cached version of customer `id`, from any list/detail/lookup entry. */
export function cachedCustomer(qc: QueryClient, id: number): { row: CustomerState; at: number } | undefined {
  let best: { row: CustomerState; at: number } | undefined
  for (const q of qc.getQueryCache().findAll({ queryKey: keys.customers.all })) {
    const row = rowsOf(q.state.data).find((r): r is CustomerState => isCustomer(r) && r.id === id)
    if (row && (!best || q.state.dataUpdatedAt > best.at)) best = { row, at: q.state.dataUpdatedAt }
  }
  return best
}

/** Customer ids a mutation's variables refer to: `id`, `[id…]`, `{ id }` or `{ ids }`. */
export function idsOf(variables: unknown): number[] {
  if (typeof variables === 'number') return [variables]
  if (Array.isArray(variables)) return variables.filter((v): v is number => typeof v === 'number')
  if (variables && typeof variables === 'object') {
    if ('ids' in variables) return idsOf(variables.ids)
    if ('id' in variables && typeof variables.id === 'number') return [variables.id]
  }
  return []
}

/** Customer rows in a mutation result: a customer, a list of them, or settleEach's `{ ok: [{ value }] }`. */
function resultRows(data: unknown): CustomerState[] {
  if (isCustomer(data)) return [data]
  if (Array.isArray(data)) return data.filter(isCustomer)
  if (data && typeof data === 'object' && 'ok' in data && Array.isArray(data.ok))
    return data.ok.map((r: { value?: unknown }) => r.value).filter(isCustomer)
  return []
}

/**
 * Detector for one signed-in session. `onChange` takes SSE change messages;
 * `watchMutations()` follows customer mutations and returns its cleanup.
 */
export function createCustomerAlerts(qc: QueryClient, notify: (a: CustomerAlert) => void = showCustomerAlert) {
  /** the last server version of each customer we processed (newer than the cache until it refetches) */
  const seen = new Map<number, { row: CustomerState; at: number }>()
  /** customer mutations in flight -> the cached rows they started from (before any optimistic patch) */
  const inFlight = new Map<Mutation<any, any, any, any>, Map<number, CustomerState | undefined>>()

  const lastKnown = (id: number) => {
    const cached = cachedCustomer(qc, id)
    const mine = seen.get(id)
    return mine && (!cached || mine.at >= cached.at) ? mine.row : cached?.row
  }
  const record = (row: CustomerState) => seen.set(row.id, { row, at: Date.now() })
  const transition = (before: CustomerState | undefined, after: CustomerState) => {
    customerAlerts(before, after).forEach(notify)
    record(after)
  }
  const writing = (id: number) => [...inFlight.values()].some((m) => m.has(id))

  return {
    /** An SSE change message. */
    onChange: (msg: { kind: string; entity?: string; row?: unknown }) => {
      if (msg.kind !== 'upsert' || msg.entity !== 'customers' || !isCustomer(msg.row)) return
      const row = msg.row
      // our own write's echo: the cache holds its optimistic state; the mutation's result decides
      if (writing(row.id)) return
      const before = lastKnown(row.id)
      // never seen before (not loaded, or a row new to us): remember it, nothing to compare with
      if (!before) return void record(row)
      transition(before, row)
    },

    /** Follow customer mutations (any `['customers', …]` key); returns the unsubscribe. */
    watchMutations: () =>
      qc.getMutationCache().subscribe((e) => {
        if (e.type !== 'updated' || e.mutation.options.mutationKey?.[0] !== 'customers') return
        const m = e.mutation
        if (e.action.type === 'pending') {
          // query-core dispatches 'pending' twice: before onMutate (the cache still holds the
          // pre-write rows) and again after it with the context — by then the optimistic patch
          // is in the cache, so only the first capture is the real "before"
          if (inFlight.has(m)) return
          inFlight.set(m, new Map(idsOf(e.action.variables).map((id) => [id, lastKnown(id)])))
        } else if (e.action.type === 'success') {
          const before = inFlight.get(m)
          inFlight.delete(m)
          const created = m.options.mutationKey?.[1] === 'create'
          for (const row of resultRows(e.action.data)) {
            if (created) transition(undefined, row)
            else if (before?.get(row.id)) transition(before.get(row.id), row)
            else record(row)
          }
        } else if (e.action.type === 'error') {
          inFlight.delete(m)
        }
      }),
  }
}
