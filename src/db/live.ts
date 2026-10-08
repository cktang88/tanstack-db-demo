import {
  COLLECTIONS,
  eventsByCategory,
  eventsCollection,
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
// incrementally — zero extra requests.

type Change =
  | { kind: 'upsert'; entity: keyof typeof COLLECTIONS | 'events'; row: { id: number } & Record<string, any> }
  | { kind: 'delete'; entity: keyof typeof COLLECTIONS | 'events'; id: number }
  | { kind: 'reset' }

const DERIVE: Record<string, (row: any) => any> = { customers: withCustomerDerived, invoices: withInvoiceDerived }

export function applyChange(change: Change) {
  if (change.kind === 'reset') {
    return Promise.all(
      [...Object.values(COLLECTIONS), eventsCollection, ...Object.values(eventsByCategory)].map((c) => c.utils.refetch()),
    )
  }
  if (change.entity === 'events' && change.kind === 'upsert') {
    // fan out to the scoped collection for this event's category as well
    const scoped = eventsByCategory[change.row.category as EventCategory]
    if (scoped) void scoped.utils.writeUpsert(change.row as never).catch(() => {})
  }
  const collection = change.entity === 'events' ? eventsCollection : COLLECTIONS[change.entity]
  if (!collection) return
  const utils = collection.utils as unknown as {
    writeUpsert: (row: unknown) => Promise<void>
    writeDelete: (id: number) => Promise<void>
  }
  // Rows may be unknown locally (not loaded yet / already removed): ignore those rejections.
  if (change.kind === 'delete') return utils.writeDelete(change.id).catch(() => {})
  const derive = DERIVE[change.entity] ?? ((r: unknown) => r)
  return utils.writeUpsert(derive(change.row)).catch(() => {})
}

export function startLiveSync() {
  if (typeof EventSource === 'undefined') return () => {}
  const source = new EventSource('/api/events/stream')
  source.addEventListener('change', (e) => void applyChange(JSON.parse((e as MessageEvent).data) as Change))
  return () => source.close()
}
