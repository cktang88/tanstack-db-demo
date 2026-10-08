import { aggregatesChanged } from './aggregates'
import {
  BY_ENTITY,
  DERIVE,
  eventsByCategory,
  FEED_PAGERS,
  isSyncing,
  landing,
  queryClient,
  sameRow,
  type EventCategory,
  type SyncUtils as Utils,
} from './collections'

// Server-sent change feed -> direct writes into the synced store.
//
// Compare with the TanStack Query version, which could only respond to
// "customer 42 changed" by invalidating every query that *might* contain it
// and refetching them all. Here a changed row that is loaded is upserted in
// place and every live query that depends on it (tables, detail pages, joins)
// updates incrementally. The server already filtered the feed by our
// permissions.
//
// On-demand collections only hold windows. A row that is not loaded can still
// belong in one (a new customer on page 1, an invoice that just became
// overdue): its collection's active windows are re-read instead of storing a
// row nobody asked for. Aggregates over the big tables (metrics, list totals)
// are server queries: they are invalidated, debounced.

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

/**
 * Re-read a resource's active windows (debounced per resource, every scoped
 * collection of it included); inactive ones refetch when next used.
 */
const pendingRefresh = new Map<string, ReturnType<typeof setTimeout>>()
function refreshWindows(entity: string) {
  if (pendingRefresh.has(entity)) return
  pendingRefresh.set(
    entity,
    setTimeout(() => {
      pendingRefresh.delete(entity)
      void queryClient.invalidateQueries({ queryKey: [entity] })
    }, 250),
  )
}

/** Collections that store rows they don't hold yet (the activity log grows at the head and the feed shows it at once). */
const STORES_NEW_ROWS = new Set(['events'])

type RowChange = Exclude<Change, { kind: 'reset' }>
const keyOf = (change: RowChange) => (change.kind === 'delete' ? change.id : change.row.id)

/**
 * Changes arrive in bursts (one server transaction publishes every row it
 * touched). They are queued per collection and written as one batch: on an
 * on-demand collection every direct write makes the query collection re-read
 * its active windows, so one batch means one re-read instead of one per row.
 */
const queued = new Map<AnyCollection, Map<number | string, RowChange>>()
let flushing: Promise<void> | undefined

function enqueue(c: AnyCollection, change: RowChange): Promise<void> {
  if (!accepts(c)) return Promise.resolve()
  const pending = queued.get(c) ?? new Map<number | string, RowChange>()
  pending.set(keyOf(change), change) // the newest change per row wins
  queued.set(c, pending)
  flushing ??= new Promise<void>((resolve) =>
    setTimeout(() => {
      flushing = undefined
      void flush().then(resolve)
    }, 10),
  )
  return flushing
}

/** A row with a local optimistic write in flight: its own commit lands the server row (persist). */
const hasPendingWrite = (c: AnyCollection, key: number | string) =>
  (c.get(key) as { $hasPendingWrites?: boolean } | undefined)?.$hasPendingWrites === true

async function flush() {
  const batches = [...queued]
  queued.clear()
  await Promise.all(batches.map(([c, changes]) => writeChanges(c, [...changes.values()])))
}

async function writeChanges(c: AnyCollection, changes: RowChange[]) {
  if (!accepts(c)) return
  const utils = c.utils as Utils
  const onDemand = c.config.syncMode === 'on-demand'
  const upserts: Array<{ id: number | string }> = []
  const deletes: Array<number | string> = []
  for (const change of changes) {
    const key = keyOf(change)
    if (hasPendingWrite(c, key)) {
      // Most likely the echo of that very write. Look again once it settled, and apply this
      // version only if it is still news then (another client may have written after us).
      setTimeout(() => void enqueue(c, change), 200)
      continue
    }
    // rows unknown locally (not loaded, or already removed) have nothing to delete
    if (change.kind === 'delete') {
      if (c.has(key)) deletes.push(key)
      continue
    }
    const derive = DERIVE[change.entity] ?? ((r: unknown) => r)
    const row = derive(change.row)
    const synced = c.base.get(row.id)
    // already stored as-is (e.g. our own write's echo, landed by persist): nothing to do
    if (sameRow(row, synced)) continue
    // On-demand: a row we don't hold may still belong in a window (a new customer on page 1):
    // re-read the windows rather than store a row nobody asked for.
    if (onDemand && synced === undefined && !c.has(row.id) && !STORES_NEW_ROWS.has(change.entity)) {
      refreshWindows(change.entity)
      continue
    }
    upserts.push(row)
  }
  if (!upserts.length && !deletes.length) return
  try {
    const inner: Array<Promise<void>> = []
    await utils
      .writeBatch(() => {
        for (const row of upserts) inner.push(utils.writeUpsert(row))
        // a row removed meanwhile is fine to "delete" again
        for (const key of deletes) inner.push(utils.writeDelete(key).catch(() => {}))
      })
      .then(() => Promise.all(inner))
  } catch (e) {
    // a sync that went away meanwhile (the next load is fresh anyway), or a real problem
    // such as a schema rejection — surface it
    console.error('[live]', e)
  }
}

export function applyChange(change: Change) {
  if (change.kind === 'reset') return resync({ includeAuth: true })
  // aggregates over the big tables are server queries: re-read the ones this change can move
  aggregatesChanged(change.entity)
  if (change.kind === 'upsert') landing(change.entity, change.row)
  // rollups we compute live on the client (e.g. customer-balances) have no collection and are ignored
  const collection = BY_ENTITY[change.entity]
  const main = collection ? enqueue(collection, change) : undefined
  if (change.entity === 'events' && change.kind === 'upsert') {
    // A new head event shifts every offset by one. Live queries count offsets
    // over local rows (which now include it), so the cursor pages cached for
    // the old head must be rebuilt from page 1 on the next window read.
    void queryClient.invalidateQueries({ queryKey: ['event-feed-pages'], refetchType: 'none' })
    // fan out to the scoped collection for this event's category as well
    const scoped = eventsByCategory[change.row.category as EventCategory]
    if (scoped) void enqueue(scoped, change)
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
