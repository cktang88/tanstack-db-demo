import type { QueryClient } from '@tanstack/react-query'
import { ENTITIES, invalidateEntities, isEntity, mutating, type Entity } from './sync'

// The server pushes every write over SSE. With plain TanStack Query the only
// generic thing we can do with "customer 42 changed" is to invalidate every
// query that *might* contain customer 42 and refetch them all (see sync.ts).

const MAX_BACKOFF = 30_000

/** A change message as the server streams it. */
export interface LiveChange {
  kind: 'upsert' | 'delete' | 'reset'
  entity?: string
  row?: unknown
  id?: number
}

/**
 * Open the change feed for the signed-in user. Call it from an effect keyed on
 * the user id and return the cleanup, so the stream follows sign-in/out and
 * user switches. `onChange` sees every message (e.g. to compare a pushed row
 * with the cached one, see alerts.ts) before it is turned into invalidations.
 */
export function startLiveUpdates(qc: QueryClient, opts: { onChange?: (msg: LiveChange) => void } = {}) {
  if (typeof EventSource === 'undefined') return () => {}
  let source: EventSource | undefined
  let stopped = false
  let connectedBefore = false
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let pending = new Set<Entity>()

  const flush = () => {
    const entities = [...pending]
    pending = new Set()
    // cancelRefetch: false — if a mutation's own invalidation is already refetching
    // these queries, the echo of that write doesn't restart the request
    void invalidateEntities(qc, entities, { cancelRefetch: false })
  }

  const onChange = (e: MessageEvent<string>) => {
    const msg = JSON.parse(e.data) as LiveChange
    try {
      opts.onChange?.(msg)
    } catch (err) {
      console.error(err) // a listener must never break cache invalidation
    }
    if (msg.kind === 'reset') {
      void qc.invalidateQueries()
      return
    }
    if (!msg.entity || !isEntity(msg.entity)) return
    // Our own optimistic write to this entity is still in flight (this is most
    // likely its echo): its onSettled invalidates once the last one finishes,
    // and refetching now would clobber its optimistic state.
    if (mutating(qc, msg.entity) > 0) return
    pending.add(msg.entity)
    // debounce bursts of writes into one round of invalidations
    clearTimeout(flushTimer)
    flushTimer = setTimeout(flush, 300)
  }

  const connect = () => {
    if (stopped) return
    const es = (source = new EventSource('/api/events/stream'))
    es.addEventListener('ready', () => {
      attempt = 0
      // (Re)connected: anything written while we were disconnected was missed,
      // so everything is suspect. The first `ready` follows the initial load.
      if (connectedBefore) void invalidateEntities(qc, ENTITIES, { cancelRefetch: false })
      connectedBefore = true
    })
    es.addEventListener('change', onChange as (e: Event) => void)
    es.addEventListener('error', () => {
      // While CONNECTING the browser retries by itself; once CLOSED (an HTTP
      // error such as 401/5xx, or a bad content type) it gives up for good.
      if (stopped || es.readyState !== EventSource.CLOSED) return
      es.close()
      retryTimer = setTimeout(connect, Math.min(MAX_BACKOFF, 1000 * 2 ** attempt++))
    })
  }

  connect()
  return () => {
    stopped = true
    clearTimeout(retryTimer)
    clearTimeout(flushTimer)
    source?.close()
  }
}
