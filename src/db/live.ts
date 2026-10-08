import {
  BY_ENTITY,
  eventsByCategory,
  queryClient,
  withCustomerDerived,
  withInvoiceDerived,
  type EventCategory,
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

const DERIVE: Record<string, (row: any) => any> = { customers: withCustomerDerived, invoices: withInvoiceDerived }
type Utils = {
  writeUpsert: (row: unknown) => Promise<void>
  writeDelete: (id: number | string) => Promise<void>
  refetch: () => Promise<unknown>
}

export function applyChange(change: Change) {
  if (change.kind === 'reset') {
    void queryClient.invalidateQueries()
    return Promise.all(
      [...Object.values(BY_ENTITY), ...Object.values(eventsByCategory)].map((c) => (c.utils as Utils).refetch().catch(() => {})),
    )
  }
  if (change.entity === 'events' && change.kind === 'upsert') {
    // fan out to the scoped collection for this event's category as well
    const scoped = eventsByCategory[change.row.category as EventCategory]
    if (scoped) void (scoped.utils as Utils).writeUpsert(change.row).catch(() => {})
  }
  const collection = BY_ENTITY[change.entity]
  if (!collection) return // rollups we compute live on the client (e.g. customer-balances) are ignored
  const utils = collection.utils as Utils
  // Rows may be unknown locally (not loaded yet / already removed): ignore those rejections.
  if (change.kind === 'delete') return utils.writeDelete(change.id).catch(() => {})
  const derive = DERIVE[change.entity] ?? ((r: unknown) => r)
  return utils.writeUpsert(derive(change.row)).catch(() => {})
}

let source: EventSource | undefined
/** (Re)connect the change feed — called after sign-in since the stream is per-user. */
export function startLiveSync() {
  if (typeof EventSource === 'undefined') return () => {}
  source?.close()
  source = new EventSource('/api/events/stream')
  source.addEventListener('change', (e) => void applyChange(JSON.parse((e as MessageEvent).data) as Change))
  return () => source?.close()
}
export const stopLiveSync = () => {
  source?.close()
  source = undefined
}
