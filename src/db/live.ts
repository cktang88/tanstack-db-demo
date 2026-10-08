import {
  BY_ENTITY,
  DERIVE,
  eventsByCategory,
  FEED_PAGERS,
  isSyncing,
  queryClient,
  type EventCategory,
  type SyncUtils as Utils,
} from './collections'

// Server-sent change feed -> direct writes into the synced store.
//
// Compare with the TanStack Query version, which could only respond to
// "customer 42 changed" by invalidating every query that *might* contain it
// and refetching them all. Here the changed row is upserted in place and every
// live query that depends on it (tables, KPIs, charts, joins) updates
// incrementally. The server already filtered the feed by our permissions.

type Change =
  | { kind: 'upsert'; entity: string; row: { id: number | string } & Record<string, any> }
  | { kind: 'delete'; entity: string; id: number | string }
  | { kind: 'reset' }

type AnyCollection = (typeof BY_ENTITY)[string]

const serverCollections = () => [...Object.values(BY_ENTITY), ...Object.values(eventsByCategory)]

/**
 * Re-read everything after the stream may have missed changes (a server-side
 * reset, or a reconnect after a network gap). Only collections that are
 * actually syncing are refetched; idle/cleaned-up ones load fresh when used.
 */
function resync({ includeAuth }: { includeAuth: boolean }) {
  for (const p of FEED_PAGERS) p.reset()
  // mark everything stale (inactive subsets refetch when next used) — the syncing collections are refetched below
  void queryClient.invalidateQueries({
    refetchType: 'none',
    ...(!includeAuth && { predicate: (q) => q.queryKey[0] !== 'auth' }),
  })
  return Promise.all(
    serverCollections()
      .filter(isSyncing)
      .map((c) => (c.utils as Utils).refetch().catch(() => {})),
  )
}

/**
 * Whether an SSE change should be written into this collection.
 *  - idle / cleaned-up collections have no sync to write into (the write would
 *    throw); they load current server state when next used.
 *  - on-demand collections only hold the windows their live queries asked for:
 *    with nobody subscribed there is nothing to keep fresh, and an unowned row
 *    would just accumulate.
 */
function accepts(c: AnyCollection) {
  if (!isSyncing(c)) return false
  return !(c.config.syncMode === 'on-demand' && c.subscriberCount === 0)
}

function write(c: AnyCollection, change: Exclude<Change, { kind: 'reset' }>): Promise<void> | undefined {
  if (!accepts(c)) return
  const utils = c.utils as Utils
  try {
    // Rows may be unknown locally (not loaded yet / already removed): ignore those rejections.
    if (change.kind === 'delete') return utils.writeDelete(change.id).catch(() => {})
    const derive = DERIVE[change.entity] ?? ((r: unknown) => r)
    // an upsert that fails is a real problem (e.g. a schema rejection) — surface it
    return utils.writeUpsert(derive(change.row)).catch((e: unknown) => console.error(`[live] ${change.entity}`, e))
  } catch (e) {
    // a sync that went away between the check and the write: the next load is fresh anyway
    console.error(`[live] ${change.entity}`, e)
  }
}

export function applyChange(change: Change) {
  if (change.kind === 'reset') return resync({ includeAuth: true })
  // rollups we compute live on the client (e.g. customer-balances) have no collection and are ignored
  const collection = BY_ENTITY[change.entity]
  const main = collection ? write(collection, change) : undefined
  if (change.entity === 'events' && change.kind === 'upsert') {
    // A new head event shifts every offset by one. Live queries count offsets
    // over local rows (which now include it), so the cursor pages cached for
    // the old head must be rebuilt from page 1 on the next window read.
    void queryClient.invalidateQueries({ queryKey: ['event-feed-pages'], refetchType: 'none' })
    // fan out to the scoped collection for this event's category as well
    const scoped = eventsByCategory[change.row.category as EventCategory]
    if (scoped) void write(scoped, change)
  }
  return main
}

let source: EventSource | undefined
let sourceUser: number | undefined

/**
 * Open the change feed for the signed-in user. The stream is per-user, so this
 * is the single owner of the connection: calling it again for the same user is
 * a no-op, for another user it reconnects.
 */
export function startLiveSync(userId: number) {
  if (typeof EventSource === 'undefined') return
  if (source && sourceUser === userId && source.readyState !== EventSource.CLOSED) return
  source?.close()
  sourceUser = userId
  const es = new EventSource('/api/events/stream')
  source = es
  let connectedBefore = false
  // `ready` is sent on every (re)connect. Changes made while the connection was
  // down were never delivered, so a reconnect resyncs everything.
  es.addEventListener('ready', () => {
    if (connectedBefore) void resync({ includeAuth: false })
    connectedBefore = true
  })
  es.addEventListener('change', (e) => void applyChange(JSON.parse((e as MessageEvent).data) as Change))
}

export function stopLiveSync() {
  source?.close()
  source = undefined
  sourceUser = undefined
}
