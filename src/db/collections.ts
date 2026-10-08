import { QueryClient } from '@tanstack/react-query'
import {
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
  type AuditEntry,
  type Contact,
  type Customer,
  type CustomerHealth,
  type CustomerTag,
  type Invoice,
  type InvoiceLineItem,
  type MrrSnapshot,
  type Notification,
  type Page,
  type Payment,
  type Product,
  type Project,
  type RoleRow,
  type Subscription,
  type Tag,
  type TaskComment,
  type Team,
  type TeamMember,
  type TimeEntry,
  type UsageDaily,
  type User,
} from '../../shared/domain'
import type { BatchOp } from '../../shared/schemas'
import { api, HttpError, type QueryParams } from '../lib/api'
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
export const TaskSchema = Schema.Struct({
  id: Schema.Int,
  projectId: Schema.Int,
  title: Schema.Trimmed.check(Schema.isMinLength(3, { message: 'Title must be at least 3 characters' }), Schema.isMaxLength(200)),
  status: Schema.Literals(TASK_STATUSES),
  priority: Schema.Literals(TASK_PRIORITIES),
  assigneeId: Schema.NullOr(Schema.Int),
  dueDate: Schema.NullOr(Schema.String),
  position: Schema.Finite,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type TaskRow = typeof TaskSchema.Type

export const CommentSchema = Schema.Struct({
  id: Schema.Int,
  taskId: Schema.Int,
  authorId: Schema.NullOr(Schema.Int),
  body: Schema.Trimmed.check(Schema.isMinLength(1, { message: 'Comment cannot be empty' }), Schema.isMaxLength(5000)),
  createdAt: Schema.String,
})

// ---------------------------------------------------------------------------
// Persistence: every collection handler (and every manual transaction) goes
// through the server's atomic batch endpoint, then writes the canonical rows
// straight into the synced store — no refetch round-trip needed.
//
// Mutation metadata:
//   { cascade: true }  a local echo of something the server does by itself
//                      (e.g. hiding an archived customer's invoices) — not sent
//   { derived: true }  an optimistic prediction of a server-computed value
//                      (invoice settled by a payment, MRR from subscriptions) —
//                      not sent; the real row is re-read after commit
// ---------------------------------------------------------------------------
type AnyCollection = Collection<any, any, any>
type SyncUtils = {
  writeBatch: (fn: () => void) => Promise<void>
  writeUpsert: (row: unknown) => Promise<void>
  writeDelete: (key: number | string) => Promise<void>
  refetch: () => Promise<unknown>
}
const ENTITY_OF = new WeakMap<AnyCollection, string>()
/** resource name -> collection (for persistence, SSE routing and resets) */
export const BY_ENTITY: Record<string, AnyCollection> = {}
const DERIVE: Record<string, (row: any) => any> = { customers: withCustomerDerived, invoices: withInvoiceDerived }
const DERIVED_FIELDS = new Set(['createdMonth', 'issuedMonth', 'paidMonth'])
const SERVER_FIELDS = new Set(['createdAt', 'updatedAt'])

const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !DERIVED_FIELDS.has(k)))
const meta = (m: PendingMutation<any>) => (m.metadata ?? {}) as { cascade?: boolean; derived?: boolean }
const keyOf = (k: unknown) => (typeof k === 'number' ? k : String(k))

export function toBatchOps(mutations: ReadonlyArray<PendingMutation<any>>): BatchOp[] {
  return mutations.flatMap((m): BatchOp[] => {
    const entity = ENTITY_OF.get(m.collection as AnyCollection)
    if (!entity) return [] // local-only collections don't persist to the server
    if (meta(m).cascade || meta(m).derived) return []
    if (m.type === 'insert') return [{ entity, op: 'insert', data: strip(m.modified) }]
    if (m.type === 'update') {
      const changes = Object.fromEntries(Object.entries(strip(m.changes)).filter(([k]) => !SERVER_FIELDS.has(k)))
      return Object.keys(changes).length ? [{ entity, op: 'update', id: keyOf(m.key), data: changes }] : []
    }
    return [{ entity, op: 'delete', id: keyOf(m.key) }]
  })
}

interface BatchResult {
  results: Array<{ entity: string; op: 'insert' | 'update' | 'delete'; id: number | string; row?: { id: number | string } }>
}

const utilsOf = (entity: string) => BY_ENTITY[entity]?.utils as SyncUtils | undefined

async function writeResults(results: BatchResult['results']) {
  const byEntity = new Map<string, BatchResult['results']>()
  for (const r of results) byEntity.set(r.entity, [...(byEntity.get(r.entity) ?? []), r])
  await Promise.all(
    [...byEntity].map(([entity, rs]) => {
      const utils = utilsOf(entity)
      if (!utils) return Promise.resolve()
      const derive = DERIVE[entity] ?? ((r: unknown) => r)
      const upserts = rs.filter((r) => r.op !== 'delete' && r.row)
      return Promise.all([
        upserts.length
          ? utils.writeBatch(() => {
              for (const r of upserts) void utils.writeUpsert(derive(r.row))
            })
          : Promise.resolve(),
        // the SSE echo may already have removed the row; that's fine
        ...rs.filter((r) => r.op === 'delete').map((r) => utils.writeDelete(r.id).catch(() => {})),
      ])
    }),
  )
}

/** Send mutations to the server atomically and reconcile synced state with the response. */
export async function persist(mutations: ReadonlyArray<PendingMutation<any>>) {
  const ops = toBatchOps(mutations)
  const results = ops.length ? (await api.post<BatchResult>('/batch', { ops })).results : []
  for (const m of mutations) {
    const entity = ENTITY_OF.get(m.collection as AnyCollection)
    if (!entity) continue
    // server-side cascades: drop the rows from the synced store too
    if (m.type === 'delete' && meta(m).cascade) results.push({ entity, op: 'delete', id: keyOf(m.key) })
  }
  // server-derived rows: read back the real values (the optimistic guess is dropped after this resolves).
  // Provisional inserts (temporary ids) have no server row to read — they simply disappear.
  const derived = mutations.filter((m) => m.type !== 'insert' && meta(m).derived && ENTITY_OF.get(m.collection as AnyCollection))
  await Promise.all(
    derived.map(async (m) => {
      const entity = ENTITY_OF.get(m.collection as AnyCollection)!
      try {
        results.push({ entity, op: 'update', id: keyOf(m.key), row: await api.get(`/${entity}/${keyOf(m.key)}`) })
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) results.push({ entity, op: 'delete', id: keyOf(m.key) })
        else throw e
      }
    }),
  )
  await writeResults(results)
}

type Mutations = { transaction: { mutations: ReadonlyArray<PendingMutation<any>> } }
const save = async ({ transaction }: Mutations) => {
  await persist(transaction.mutations)
  return { refetch: false }
}

// Auto-index every field a live query filters, joins or orders on (B-tree, so
// `orderBy + limit` windows can be read lazily instead of sorting everything).
const indexing = { autoIndex: 'eager', defaultIndexType: BTreeIndex } as const

/**
 * Eager collection for a server resource: loads the whole table once, then
 * every filter/sort/join/aggregate runs locally. The resource's server-side
 * mode decides which handlers exist — an append-only collection simply has no
 * onUpdate/onDelete, so `collection.update()` throws before anything happens.
 */
function serverCollection<T extends object, K extends string | number>(
  entity: string,
  getKey: (row: T) => K,
  opts: { mode?: 'crud' | 'append-only' | 'read-only'; params?: QueryParams; map?: (row: any) => T } = {},
) {
  const mode = opts.mode ?? 'crud'
  const collection = createCollection(
    queryCollectionOptions({
      id: entity,
      queryKey: [entity],
      queryClient,
      getKey,
      ...indexing,
      queryFn: async ({ signal }) => {
        const rows = (await api.get<Page<T>>(`/${entity}`, { limit: 10_000, ...opts.params }, signal)).data
        return opts.map ? rows.map(opts.map) : rows
      },
      ...(mode !== 'read-only' && { onInsert: save }),
      ...(mode === 'crud' && { onUpdate: save, onDelete: save }),
    }),
  )
  ENTITY_OF.set(collection as AnyCollection, entity)
  BY_ENTITY[entity] = collection as AnyCollection
  return collection
}

/**
 * On-demand collection: nothing is loaded up front. Each live query's
 * where/orderBy/limit/offset is pushed down to the REST API, and identical or
 * overlapping requests are deduplicated.
 */
function onDemandCollection<T extends object, K extends string | number>(
  entity: string,
  getKey: (row: T) => K,
  opts: { id?: string; scope?: Record<string, string>; mode?: 'append-only' | 'read-only'; map?: (row: any) => T } = {},
) {
  const collection = createCollection(
    queryCollectionOptions({
      id: opts.id ?? entity,
      // business scope goes into the key (and every request); the subset identity is appended per live query
      queryKey: opts.scope ? [entity, opts.scope] : [entity],
      queryClient,
      syncMode: 'on-demand',
      getKey,
      staleTime: 10_000,
      ...indexing,
      queryFn: async (ctx) => {
        const search = loadSubsetToSearch(ctx.meta?.loadSubsetOptions)
        for (const [k, v] of Object.entries(opts.scope ?? {})) search.set(k, v)
        const res = await fetch(`/api/${entity}?${search}`, { signal: ctx.signal })
        if (!res.ok) throw new HttpError(res.status, await res.json().catch(() => undefined))
        const rows = ((await res.json()) as Page<T>).data
        return opts.map ? rows.map(opts.map) : rows
      },
      ...(opts.mode === 'append-only' && { onInsert: save }),
    }),
  )
  if (!opts.id) {
    ENTITY_OF.set(collection as AnyCollection, entity)
    BY_ENTITY[entity] = collection as AnyCollection
  }
  return collection
}

// ============================== identity & access ==============================
export const usersCollection = serverCollection<User, number>('users', (u) => u.id)
export const rolesCollection = serverCollection<RoleRow, string>('roles', (r) => r.id, { mode: 'read-only' })
export const permissionsCollection = serverCollection<{ id: string; description: string }, string>('permissions', (p) => p.id, {
  mode: 'read-only',
})
export const rolePermissionsCollection = serverCollection<{ id: string; roleId: string; permissionId: string }, string>(
  'role-permissions',
  (r) => r.id,
  {
    mode: 'read-only',
  },
)
export const teamsCollection = serverCollection<Team, number>('teams', (t) => t.id)
export const teamMembersCollection = serverCollection<TeamMember, string>('team-members', (m) => m.id)
/** only *my* sessions — the server scopes the rows to the caller */
export const sessionsCollection = serverCollection<
  { id: number; userId: number; createdAt: string; expiresAt: string; userAgent: string | null },
  number
>('sessions', (s) => s.id)
/** only *my* notifications */
export const notificationsCollection = serverCollection<Notification, number>('notifications', (n) => n.id)

// ============================== CRM ==============================
export const customersCollection = serverCollection<CustomerRow, number>('customers', (c) => c.id, { map: withCustomerDerived })
export const contactsCollection = serverCollection<Contact, number>('contacts', (c) => c.id)
export const tagsCollection = serverCollection<Tag, number>('tags', (t) => t.id)
export const customerTagsCollection = serverCollection<CustomerTag, string>('customer-tags', (t) => t.id)

// ============================== catalog & billing ==============================
export const productsCollection = serverCollection<Product, number>('products', (p) => p.id)
export const subscriptionsCollection = serverCollection<Subscription, number>('subscriptions', (s) => s.id)
export const invoicesCollection = serverCollection<InvoiceRow, number>('invoices', (i) => i.id, { map: withInvoiceDerived })
export const mrrSnapshotsCollection = serverCollection<MrrSnapshot, string>('mrr-snapshots', (s) => s.id, { mode: 'read-only' })
/** the payment ledger is large and append-only: load windows on demand, insert-only */
export const paymentsCollection = onDemandCollection<Payment, number>('payments', (p) => p.id, { mode: 'append-only' })
/** issued invoices are immutable; fetched per invoice on demand */
export const lineItemsCollection = onDemandCollection<InvoiceLineItem, number>('invoice-line-items', (l) => l.id, {
  mode: 'read-only',
})

// ============================== delivery ==============================
export const projectsCollection = serverCollection<ProjectRow, number>('projects', (p) => p.id)
export const tasksCollection = createCollection(
  queryCollectionOptions({
    id: 'tasks',
    queryKey: ['tasks'],
    queryClient,
    schema: Schema.toStandardSchemaV1(TaskSchema),
    getKey: (t: TaskRow) => t.id,
    ...indexing,
    queryFn: async ({ signal }) => (await api.get<Page<TaskRow>>('/tasks', { limit: 10_000 }, signal)).data,
    onInsert: save,
    onUpdate: save,
    onDelete: save,
  }),
)
ENTITY_OF.set(tasksCollection as AnyCollection, 'tasks')
BY_ENTITY.tasks = tasksCollection as AnyCollection

/** append-only: no update/delete handlers, validated by an Effect Schema */
export const commentsCollection = createCollection(
  queryCollectionOptions({
    id: 'task-comments',
    queryKey: ['task-comments'],
    queryClient,
    schema: Schema.toStandardSchemaV1(CommentSchema),
    getKey: (c: TaskComment) => c.id,
    ...indexing,
    queryFn: async ({ signal }) => (await api.get<Page<TaskComment>>('/task-comments', { limit: 10_000 }, signal)).data,
    onInsert: save,
  }),
)
ENTITY_OF.set(commentsCollection as AnyCollection, 'task-comments')
BY_ENTITY['task-comments'] = commentsCollection as AnyCollection

export const timeEntriesCollection = serverCollection<TimeEntry, number>('time-entries', (e) => e.id)

// ============================== metering & views ==============================
export const usageDailyCollection = onDemandCollection<UsageDaily, string>('usage-daily', (u) => u.id, { mode: 'read-only' })
export const customerHealthCollection = onDemandCollection<CustomerHealth, number>('customer-health', (h) => h.id, {
  mode: 'read-only',
})

// ============================== logs ==============================
export const auditCollection = onDemandCollection<AuditEntry, number>('audit-log', (a) => a.id, { mode: 'read-only' })

export const EVENT_CATEGORIES = ['customer', 'invoice', 'task', 'payment', 'subscription', 'comment'] as const
export type EventCategory = (typeof EVENT_CATEGORIES)[number]
/** The whole activity log (on-demand). */
export const eventsCollection = onDemandCollection<ActivityEvent, number>('events', (e) => e.id)
/**
 * Business-scoped collection factory: one on-demand collection per category.
 * The scope is a fixed part of every request, so live queries over it need no
 * `where` and their windows push down as a plain `sort + limit (+ offset)`.
 */
export const eventsByCategory = Object.fromEntries(
  EVENT_CATEGORIES.map((c) => [
    c,
    onDemandCollection<ActivityEvent, number>('events', (e) => e.id, { id: `events:${c}`, scope: { 'category[eq]': c } }),
  ]),
) as Record<EventCategory, typeof eventsCollection>

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
  localStorageCollectionOptions({ id: 'prefs', storageKey: 'saasly:prefs', getKey: (p: Prefs) => p.id }),
)

/** Pinned accounts (localStorage) — joined with server customers in live queries. */
export interface Pin {
  id: number
  pinnedAt: string
}
export const pinsCollection = createCollection(
  localStorageCollectionOptions({ id: 'pins', storageKey: 'saasly:pins', getKey: (p: Pin) => p.id }),
)

/** Table row selection (in-memory) — survives paging/filtering, joinable for summaries. */
export interface Selected {
  id: number
}
export const selectionCollection = createCollection(
  localOnlyCollectionOptions({ id: 'customer-selection', getKey: (s: Selected) => s.id }),
)

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
/** Eager collections a signed-in session needs for most pages. */
export const CORE = [usersCollection, customersCollection, invoicesCollection, projectsCollection, tasksCollection] as const

export const preloadAll = () => Promise.all(CORE.map((c) => c.preload()))

/**
 * Sign-in / sign-out: drop every server-backed collection's rows and cache so
 * nothing from the previous user can leak into the next session.
 */
export async function resetServerCollections() {
  const all = [...Object.values(BY_ENTITY), ...Object.values(eventsByCategory)]
  await Promise.all(all.map((c) => c.cleanup()))
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' })
}

/** Client-side id generation: rows get their final id before the server sees them (no temp-id swap). */
let lastId = 0
export function newId() {
  // ms timestamp * 1000 + counter: unique per tab, increasing, a safe integer
  const base = Date.now() * 1000
  lastId = Math.max(lastId + 1, base)
  return lastId % 2_000_000_000_000_000
}
