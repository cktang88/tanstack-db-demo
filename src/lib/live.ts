import type { QueryClient } from '@tanstack/react-query'
import { keys } from './queries'

// The server pushes every write over SSE. With plain TanStack Query the only
// generic thing we can do with "customer 42 changed" is to invalidate every
// query that *might* contain customer 42 and refetch them all.
const ENTITY_KEYS: Record<string, ReadonlyArray<readonly unknown[]>> = {
  customers: [keys.customers.all, keys.metrics.all],
  invoices: [keys.invoices.all, keys.metrics.all],
  tasks: [keys.tasks.all, keys.projects.all, keys.metrics.workload()],
  projects: [keys.projects.all],
  users: [keys.users.all],
  events: [keys.events.all],
}

export function startLiveUpdates(qc: QueryClient) {
  if (typeof EventSource === 'undefined') return () => {}
  const source = new EventSource('/api/events/stream')
  let pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  source.addEventListener('change', (e) => {
    const msg = JSON.parse((e as MessageEvent).data) as { kind: string; entity?: string }
    if (msg.kind === 'reset') {
      void qc.invalidateQueries()
      return
    }
    if (msg.entity) pending.add(msg.entity)
    // debounce bursts of writes into one round of invalidations
    clearTimeout(timer)
    timer = setTimeout(() => {
      const entities = pending
      pending = new Set()
      for (const entity of entities)
        for (const queryKey of ENTITY_KEYS[entity] ?? []) void qc.invalidateQueries({ queryKey: [...queryKey] })
    }, 300)
  })
  return () => source.close()
}
