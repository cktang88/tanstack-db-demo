import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { keys } from './queries'

// ----------------------------------------------------------------------------
// Single source of truth for "which cache entries may contain entity X".
// Used both by the SSE change feed (live.ts) and by every mutation's
// onSettled, so a server change and a local write invalidate the same queries.
// Entity names are the server's resource names; every mutation key starts
// with the entity it writes (['customers', 'update'], ['tasks', 'create'], …)
// so `qc.isMutating({ mutationKey: [entity] })` counts in-flight writes.
// ----------------------------------------------------------------------------
export const ENTITY_KEYS = {
  customers: [keys.customers.all, keys.metrics.all, ['customer-health']],
  invoices: [keys.invoices.all, keys.metrics.all, ['customer-health']],
  payments: [['payments'], keys.metrics.all],
  'customer-balances': [['customer-balances'], keys.metrics.all],
  subscriptions: [['subscriptions'], keys.metrics.all],
  'mrr-snapshots': [['mrr-snapshots']],
  contacts: [['contacts']],
  'customer-tags': [['customer-tags']],
  tags: [['tags']],
  products: [['products']],
  tasks: [keys.tasks.all, keys.projects.all, keys.metrics.workload(), ['project-stats']],
  'task-comments': [['task-comments']],
  'time-entries': [['time-entries'], ['project-stats']],
  'project-stats': [['project-stats']],
  projects: [keys.projects.all, ['project-stats']],
  // the signed-in user's own row (role, name) and team memberships live in /auth/me too
  users: [keys.users.all, ['auth', 'me']],
  teams: [['teams']],
  'team-members': [['team-members'], ['auth', 'me']],
  'usage-daily': [['usage-daily'], ['customer-health']],
  notifications: [['notifications']],
  sessions: [['sessions']],
  events: [keys.events.all],
} as const satisfies Record<string, ReadonlyArray<QueryKey>>

export type Entity = keyof typeof ENTITY_KEYS
export const ENTITIES = Object.keys(ENTITY_KEYS) as Entity[]
export const isEntity = (e: string): e is Entity => e in ENTITY_KEYS

/** In-flight mutations writing `entity`. */
export const mutating = (qc: QueryClient, entity: string) => qc.isMutating({ mutationKey: [entity] })

/**
 * Invalidate everything that may contain `entities`.
 *
 * Entities that still have optimistic writes in flight are skipped: refetching
 * them now would overwrite those writes' optimistic cache state with server
 * data that doesn't include them yet. The last mutation on that entity to
 * settle invalidates it instead (the TkDodo "isMutating() === 1" pattern).
 * `self` is the entity of the settling mutation, which still counts itself.
 */
export function invalidateEntities(
  qc: QueryClient,
  entities: readonly Entity[],
  opts: { self?: string; cancelRefetch?: boolean } = {},
) {
  const seen = new Set<string>()
  const queryKeys = entities
    .filter((e) => mutating(qc, e) <= (e === opts.self ? 1 : 0))
    .flatMap((e): ReadonlyArray<QueryKey> => ENTITY_KEYS[e])
    .filter((k) => {
      const id = JSON.stringify(k)
      return !seen.has(id) && !!seen.add(id)
    })
  return Promise.all(
    queryKeys.map((queryKey) => qc.invalidateQueries({ queryKey: [...queryKey] }, { cancelRefetch: opts.cancelRefetch ?? true })),
  )
}
