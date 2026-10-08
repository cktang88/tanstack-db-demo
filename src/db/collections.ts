import { QueryClient } from '@tanstack/react-query'
import {
  BasicIndex,
  BTreeIndex,
  createCollection,
  localOnlyCollectionOptions,
  localStorageCollectionOptions,
  type Collection,
  type PendingMutation,
} from '@tanstack/react-db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { Schema } from 'effect'
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type ActivityEvent,
  type Customer,
  type Invoice,
  type Page,
  type Project,
  type User,
} from '../../shared/domain'
import type { BatchEntity, BatchOp } from '../../shared/schemas'
import { api } from '../lib/api'
import { loadSubsetToSearch } from './pushdown'

// ---------------------------------------------------------------------------
// One QueryClient is still the cache + fetch engine underneath every
// collection. TanStack DB adds a normalized, queryable client store on top.
// ---------------------------------------------------------------------------
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false } },
})

// ---------------------------------------------------------------------------
// Row types. Derived month buckets are added at load time so charts can
// `groupBy` them with no server aggregation endpoint.
// ---------------------------------------------------------------------------
export type CustomerRow = Customer & { createdMonth: string }
export type InvoiceRow = Invoice & { issuedMonth: string; paidMonth: string | null }
export type ProjectRow = Project
export type { User, ActivityEvent }

export const withCustomerDerived = (c: Customer): CustomerRow => ({ ...c, createdMonth: c.createdAt.slice(0, 7) })
export const withInvoiceDerived = (i: Invoice): InvoiceRow => ({
  ...i,
  issuedMonth: i.issuedAt.slice(0, 7),
  paidMonth: i.status === 'paid' ? (i.paidAt ?? i.issuedAt).slice(0, 7) : null,
})

// Effect Schema doubles as the collection's Standard Schema: every optimistic
// insert/update on tasks is validated client-side *before* it touches the UI.
const IsoString = Schema.String
export const TaskSchema = Schema.Struct({
  id: Schema.Int,
  projectId: Schema.Int,
  title: Schema.Trimmed.check(Schema.isMinLength(3, { message: 'Title must be at least 3 characters' }), Schema.isMaxLength(200)),
  status: Schema.Literals(TASK_STATUSES),
  priority: Schema.Literals(TASK_PRIORITIES),
  assigneeId: Schema.NullOr(Schema.Int),
  dueDate: Schema.NullOr(Schema.String),
  position: Schema.Finite,
  createdAt: IsoString,
  updatedAt: IsoString,
})
export type TaskRow = typeof TaskSchema.Type

// ---------------------------------------------------------------------------
// Persistence: every collection handler (and every manual transaction) goes
// through one atomic batch endpoint, then writes the server's canonical rows
// straight into the synced store — no refetch round-trip needed.
// ---------------------------------------------------------------------------
type AnyCollection = Collection<any, any, any>
const ENTITY_OF = new WeakMap<AnyCollection, BatchEntity>()
const DERIVE: Partial<Record<BatchEntity, (row: any) => any>> = { customers: withCustomerDerived, invoices: withInvoiceDerived }
const DERIVED_FIELDS = new Set(['createdMonth', 'issuedMonth', 'paidMonth'])

const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !DERIVED_FIELDS.has(k)))

export function toBatchOps(mutations: ReadonlyArray<PendingMutation<any>>): BatchOp[] {
  return mutations.flatMap((m): BatchOp[] => {
    const entity = ENTITY_OF.get(m.collection as AnyCollection)
    if (!entity) return [] // local-only collections don't persist to the server
    if ((m.metadata as { cascade?: boolean } | undefined)?.cascade) return [] // the server cascades these itself
    if (m.type === 'insert') return [{ entity, op: 'insert', data: strip(m.modified) }]
    if (m.type === 'update') {
      const { createdAt, updatedAt, ...changes } = strip(m.changes)
      void createdAt
      void updatedAt
      return Object.keys(changes).length ? [{ entity, op: 'update', id: Number(m.key), data: changes }] : []
    }
    return [{ entity, op: 'delete', id: Number(m.key) }]
  })
}

interface BatchResult {
  results: Array<{ entity: BatchEntity; op: 'insert' | 'update' | 'delete'; id: number; row?: { id: number } }>
}

/** Send mutations to the server atomically and reconcile synced state with the response. */
export async function persist(mutations: ReadonlyArray<PendingMutation<any>>) {
  const ops = toBatchOps(mutations)
  if (!ops.length) return
  const { results } = await api.post<BatchResult>('/batch', { ops })
  // rows deleted by a server-side cascade: remove them from the synced store too
  for (const m of mutations)
    if (m.type === 'delete' && (m.metadata as { cascade?: boolean } | undefined)?.cascade) {
      const entity = ENTITY_OF.get(m.collection as AnyCollection)
      if (entity) results.push({ entity, op: 'delete', id: Number(m.key) })
    }
  const byEntity = new Map<BatchEntity, BatchResult['results']>()
  for (const r of results) byEntity.set(r.entity, [...(byEntity.get(r.entity) ?? []), r])
  await Promise.all(
    [...byEntity].map(([entity, rs]) => {
      const collection = COLLECTIONS[entity] as unknown as { utils: SyncUtils }
      const derive = DERIVE[entity] ?? ((r: unknown) => r)
      const upserts = rs.filter((r) => r.op !== 'delete')
      const deletes = rs.filter((r) => r.op === 'delete')
      return Promise.all([
        upserts.length &&
          collection.utils.writeBatch(() => {
            for (const r of upserts) void collection.utils.writeUpsert(derive(r.row))
          }),
        // the SSE echo may already have removed the row; that's fine
        ...deletes.map((r) => collection.utils.writeDelete(r.id).catch(() => {})),
      ])
    }),
  )
}

interface SyncUtils {
  writeBatch: (fn: () => void) => Promise<void>
  writeUpsert: (row: unknown) => Promise<void>
  writeDelete: (key: number) => Promise<void>
  refetch: () => Promise<unknown>
}

const handlers = {
  onInsert: async ({ transaction }: { transaction: { mutations: ReadonlyArray<PendingMutation<any>> } }) => {
    await persist(transaction.mutations)
    return { refetch: false }
  },
  onUpdate: async ({ transaction }: { transaction: { mutations: ReadonlyArray<PendingMutation<any>> } }) => {
    await persist(transaction.mutations)
    return { refetch: false }
  },
  onDelete: async ({ transaction }: { transaction: { mutations: ReadonlyArray<PendingMutation<any>> } }) => {
    await persist(transaction.mutations)
    return { refetch: false }
  },
}

const ALL = { limit: 10_000 }

// Auto-index every field a live query filters, joins or orders on (B-tree, so
// `orderBy + limit` windows can be read lazily instead of sorting everything).
const indexing = { autoIndex: 'eager', defaultIndexType: BTreeIndex } as const

// ---------------------------------------------------------------------------
// Server-backed collections (eager: load the whole table once, then every
// filter/sort/join/aggregate runs locally in sub-millisecond time).
// ---------------------------------------------------------------------------
export const usersCollection = createCollection(
  queryCollectionOptions({
    id: 'users',
    queryKey: ['users'],
    queryClient,
    getKey: (u: User) => u.id,
    queryFn: async ({ signal }) => (await api.get<Page<User>>('/users', ALL, signal)).data,
    ...indexing,
    ...handlers,
  }),
)

export const customersCollection = createCollection(
  queryCollectionOptions({
    id: 'customers',
    queryKey: ['customers'],
    queryClient,
    getKey: (c: CustomerRow) => c.id,
    queryFn: async ({ signal }) => (await api.get<Page<Customer>>('/customers', ALL, signal)).data.map(withCustomerDerived),
    ...indexing,
    ...handlers,
  }),
)

export const invoicesCollection = createCollection(
  queryCollectionOptions({
    id: 'invoices',
    queryKey: ['invoices'],
    queryClient,
    getKey: (i: InvoiceRow) => i.id,
    queryFn: async ({ signal }) => (await api.get<Page<Invoice>>('/invoices', ALL, signal)).data.map(withInvoiceDerived),
    ...indexing,
    ...handlers,
  }),
)

export const projectsCollection = createCollection(
  queryCollectionOptions({
    id: 'projects',
    queryKey: ['projects'],
    queryClient,
    getKey: (p: ProjectRow) => p.id,
    // the API also returns aggregate counts; we drop them and compute progress live from tasks instead
    queryFn: async ({ signal }) =>
      (await api.get<Page<Project & { taskCount?: number; doneCount?: number }>>('/projects', ALL, signal)).data.map(
        ({ taskCount: _taskCount, doneCount: _doneCount, ...p }) => p,
      ),
    ...indexing,
    ...handlers,
  }),
)

export const tasksCollection = createCollection(
  queryCollectionOptions({
    id: 'tasks',
    queryKey: ['tasks'],
    queryClient,
    schema: Schema.toStandardSchemaV1(TaskSchema),
    getKey: (t: TaskRow) => t.id,
    queryFn: async ({ signal }) => (await api.get<Page<TaskRow>>('/tasks', ALL, signal)).data,
    ...indexing,
    ...handlers,
  }),
)

// ---------------------------------------------------------------------------
// On-demand collection: the activity log can grow without bound, so nothing is
// loaded up front. Each live query's where/orderBy/limit/offset is pushed down
// to the API, and identical/overlapping requests are deduplicated.
// ---------------------------------------------------------------------------
function makeEventsCollection(category?: EventCategory) {
  return createCollection(
    queryCollectionOptions({
      id: category ? `events:${category}` : 'events',
      // business scope goes into the key (and the request); the subset identity is appended per live query
      queryKey: category ? ['events', category] : ['events'],
      queryClient,
      syncMode: 'on-demand',
      getKey: (e: ActivityEvent) => e.id,
      staleTime: 10_000,
      ...indexing,
      queryFn: async (ctx) => {
        const search = loadSubsetToSearch(ctx.meta?.loadSubsetOptions)
        if (category) search.set('category[eq]', category)
        const res = await fetch(`/api/events?${search}`, { signal: ctx.signal })
        if (!res.ok) throw new Error(`Failed to load events (${res.status})`)
        return ((await res.json()) as Page<ActivityEvent>).data
      },
    }),
  )
}

export const EVENT_CATEGORIES = ['customer', 'invoice', 'task'] as const
export type EventCategory = (typeof EVENT_CATEGORIES)[number]

/** The whole activity log (on-demand). */
export const eventsCollection = makeEventsCollection()
/**
 * Business-scoped collection factory: one on-demand collection per category.
 * The scope is a fixed part of every request, so live queries over it need no
 * `where` and their windows push down as a plain `sort + limit`.
 */
export const eventsByCategory: Record<EventCategory, ReturnType<typeof makeEventsCollection>> = {
  customer: makeEventsCollection('customer'),
  invoice: makeEventsCollection('invoice'),
  task: makeEventsCollection('task'),
}

// ---------------------------------------------------------------------------
// Client-only collections.
// ---------------------------------------------------------------------------

/** UI preferences: persisted to localStorage and synced across tabs automatically. */
export interface Prefs {
  id: 'prefs'
  theme: 'light' | 'dark'
  compact: boolean
  defaultPageSize: number
}
export const DEFAULT_PREFS: Prefs = { id: 'prefs', theme: 'light', compact: false, defaultPageSize: 25 }
export const prefsCollection = createCollection(
  localStorageCollectionOptions({
    id: 'prefs',
    storageKey: 'saasly:prefs',
    getKey: (p: Prefs) => p.id,
  }),
)

/** Pinned accounts (localStorage) — joined with server customers in live queries. */
export interface Pin {
  id: number
  pinnedAt: string
}
export const pinsCollection = createCollection(
  localStorageCollectionOptions({
    id: 'pins',
    storageKey: 'saasly:pins',
    getKey: (p: Pin) => p.id,
  }),
)

/** Table row selection (in-memory) — survives paging/filtering, joinable for summaries. */
export interface Selected {
  id: number
}
export const selectionCollection = createCollection(
  localOnlyCollectionOptions({
    id: 'customer-selection',
    getKey: (s: Selected) => s.id,
  }),
)

// ---------------------------------------------------------------------------
// Indexes make `where eq(...)` / join lookups O(1) instead of a scan.
// ---------------------------------------------------------------------------
invoicesCollection.createIndex((i) => i.customerId, { indexType: BasicIndex })
invoicesCollection.createIndex((i) => i.status, { indexType: BasicIndex })
tasksCollection.createIndex((t) => t.projectId, { indexType: BasicIndex })
tasksCollection.createIndex((t) => t.assigneeId, { indexType: BasicIndex })
customersCollection.createIndex((c) => c.status, { indexType: BasicIndex })

export const COLLECTIONS = {
  users: usersCollection,
  customers: customersCollection,
  invoices: invoicesCollection,
  projects: projectsCollection,
  tasks: tasksCollection,
}
for (const [entity, collection] of Object.entries(COLLECTIONS)) ENTITY_OF.set(collection as AnyCollection, entity as BatchEntity)

/** Start loading every eager collection (used by route loaders / app boot). */
export const preloadAll = () => Promise.all(Object.values(COLLECTIONS).map((c) => c.preload()))

/** Client-side id generation: rows get their final id before the server sees them (no temp-id swap). */
let lastId = 0
export function newId() {
  // ms timestamp * 1000 + counter stays a safe integer for centuries and is unique per tab
  const base = Date.now() * 1000
  lastId = Math.max(lastId + 1, base)
  return lastId % 2_000_000_000_000_000 // keep well inside Number.MAX_SAFE_INTEGER
}
