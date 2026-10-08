import { QueryClient } from '@tanstack/react-query'
import {
  BTreeIndex,
  createCollection,
  localOnlyCollectionOptions,
  localStorageCollectionOptions,
  type Collection,
  type PendingMutation,
} from '@tanstack/react-db'
import { createCursorPager, queryCollectionOptions, type CursorPager } from '@tanstack/query-db-collection'
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
import { aggregatesChanged } from './aggregates'
import { customerAlertsDetector } from './alerts'
import {
  isNewestFirstWindow,
  loadSubsetToSearch,
  MAX_ROWS,
  searchText,
  sortKey,
  uniqueLookup,
  type PushdownSpec,
} from './pushdown'

// ---------------------------------------------------------------------------
// One QueryClient is still the cache + fetch engine underneath every
// collection. TanStack DB adds a normalized, queryable client store on top.
// ---------------------------------------------------------------------------
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // 4xx (auth, permissions, bad filters) won't fix themselves: fail fast; retry 5xx/network twice
      retry: (n, e) => !(e instanceof HttpError && e.status < 500) && n < 2,
    },
  },
})

// ---------------------------------------------------------------------------
// Row types. Client-derived fields are added to every row written from the
// server (responses and SSE) and never sent back (see DERIVED_FIELDS):
//  - month buckets, so charts over bounded data can `groupBy` them
//  - `searchText` / `order`, so the big on-demand collections can push the
//    server's search and sort down (see pushdown.ts)
// ---------------------------------------------------------------------------
/** sort keys of the customers table -> the server's sort field (`owner` is a virtual sort key) */
export const CUSTOMER_SORTS = {
  company: 'company',
  name: 'name',
  plan: 'plan',
  status: 'status',
  country: 'country',
  seats: 'seats',
  mrr: 'mrr',
  createdAt: 'createdAt',
  owner: 'owner',
} as const
/** sort keys of the invoices table -> the server's sort field */
export const INVOICE_SORTS = {
  number: 'number',
  company: 'customerCompany',
  status: 'status',
  issuedAt: 'issuedAt',
  dueAt: 'dueAt',
  paidAt: 'paidAt',
  amount: 'amount',
} as const
export type CustomerSort = keyof typeof CUSTOMER_SORTS
export type InvoiceSort = keyof typeof INVOICE_SORTS

export type CustomerRow = Customer & {
  createdMonth: string
  /** the owner's name, looked up in the (eager) users collection */
  ownerName: string | null
  /** name, email, company and owner name: what the server's `?q=` searches */
  searchText: string
  order: Record<CustomerSort, string>
}
export type InvoiceRow = Invoice & {
  issuedMonth: string
  paidMonth: string | null
  /** invoice number and customer company: what the server's `?q=` searches */
  searchText: string
  order: Record<InvoiceSort, string>
}
export type ProjectRow = Project
export type { User, ActivityEvent }

const ownerNameOf = (ownerId: number | null) =>
  ownerId === null ? null : ((usersCollection.get(ownerId) as User | undefined)?.name ?? null)

export const withCustomerDerived = (c: Customer): CustomerRow => {
  const ownerName = ownerNameOf(c.ownerId)
  return {
    ...c,
    createdMonth: c.createdAt.slice(0, 7),
    ownerName,
    searchText: searchText(c.name, c.email, c.company, ownerName),
    order: {
      company: sortKey(c.company, c.id),
      name: sortKey(c.name, c.id),
      plan: sortKey(c.plan, c.id),
      status: sortKey(c.status, c.id),
      country: sortKey(c.country, c.id),
      seats: sortKey(c.seats, c.id),
      mrr: sortKey(c.mrr, c.id),
      createdAt: sortKey(c.createdAt, c.id),
      owner: sortKey(ownerName, c.id),
    },
  }
}
export const withInvoiceDerived = (i: Invoice): InvoiceRow => ({
  ...i,
  issuedMonth: i.issuedAt.slice(0, 7),
  paidMonth: i.status === 'paid' ? (i.paidAt ?? i.issuedAt).slice(0, 7) : null,
  searchText: searchText(i.number, i.customerCompany),
  order: {
    number: sortKey(i.number, i.id),
    company: sortKey(i.customerCompany, i.id),
    status: sortKey(i.status, i.id),
    issuedAt: sortKey(i.issuedAt, i.id),
    dueAt: sortKey(i.dueAt, i.id),
    paidAt: sortKey(i.paidAt, i.id),
    amount: sortKey(i.amount, i.id),
  },
})

/** Recompute the derived fields of an optimistic draft after its source fields changed. */
export const rederiveCustomer = (d: CustomerRow) => {
  const { createdMonth, ownerName, searchText, order } = withCustomerDerived(d)
  Object.assign(d, { createdMonth, ownerName, searchText, order })
}
export const rederiveInvoice = (d: InvoiceRow) => {
  const { issuedMonth, paidMonth, searchText, order } = withInvoiceDerived(d)
  Object.assign(d, { issuedMonth, paidMonth, searchText, order })
}

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
export type SyncUtils = {
  writeBatch: (fn: () => void) => Promise<void>
  writeUpsert: (row: unknown) => Promise<void>
  writeDelete: (key: number | string) => Promise<void>
  refetch: () => Promise<unknown>
}
type Mode = 'crud' | 'append-only' | 'read-only'
const ENTITY_OF = new WeakMap<AnyCollection, string>()
/** resource name -> collection (for persistence, SSE routing and resets) */
export const BY_ENTITY: Record<string, AnyCollection> = {}
/** resource name -> what the server accepts for it (mirrors server/resources.ts) */
const MODE_OF: Record<string, Mode> = {}
const register = (collection: AnyCollection, entity: string, mode: Mode) => {
  ENTITY_OF.set(collection, entity)
  BY_ENTITY[entity] = collection
  MODE_OF[entity] = mode
}
/** client-side derived columns per entity, applied to every row written from the server (responses and SSE) */
export const DERIVE: Record<string, (row: any) => any> = { customers: withCustomerDerived, invoices: withInvoiceDerived }
/** client-side derived buckets — never part of the API */
const DERIVED_FIELDS = new Set(['createdMonth', 'issuedMonth', 'paidMonth', 'ownerName', 'searchText', 'order'])
/**
 * Fields the server computes or forces itself (see server/resources.ts and the
 * business handlers). They exist on optimistic rows so the UI can show them,
 * but are never sent: the canonical values come back in the batch response.
 */
const SERVER_FIELDS: Record<string, ReadonlySet<string>> = {
  '*': new Set(['createdAt', 'updatedAt']),
  customers: new Set(['mrr', 'teamId']),
  invoices: new Set(['number', 'customerId', 'amount', 'issuedAt', 'paidAt', 'customerCompany']),
  payments: new Set(['customerId', 'reference', 'receivedAt', 'recordedBy']),
  subscriptions: new Set(['unitPrice', 'startedAt', 'canceledAt']),
  'task-comments': new Set(['authorId']),
  'time-entries': new Set(['userId']),
}

const writable = (entity: string, o: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(o).filter(([k]) => !DERIVED_FIELDS.has(k) && !SERVER_FIELDS['*']!.has(k) && !SERVER_FIELDS[entity]?.has(k)),
  )
const meta = (m: PendingMutation<any>) => (m.metadata ?? {}) as { cascade?: boolean; derived?: boolean }
const keyOf = (k: unknown) => (typeof k === 'number' ? k : String(k))

/** Thrown before any request when a transaction touches a collection in a way the server never accepts. */
export class UnsupportedMutationError extends Error {
  constructor(entity: string, op: string, mode: Mode) {
    super(`Cannot ${op} ${entity}: the resource is ${mode}`)
    this.name = 'UnsupportedMutationError'
  }
}

export function toBatchOps(mutations: ReadonlyArray<PendingMutation<any>>): BatchOp[] {
  return mutations.flatMap((m): BatchOp[] => {
    const entity = ENTITY_OF.get(m.collection as AnyCollection)
    if (!entity) return [] // local-only collections don't persist to the server
    if (meta(m).cascade || meta(m).derived) return []
    // Inside an ambient transaction, collection.update()/delete() don't check
    // for handlers, so enforce the resource's mode here instead of letting the
    // server answer 405 after the UI already showed the change.
    const mode = MODE_OF[entity] ?? 'crud'
    if (mode === 'read-only' || (mode === 'append-only' && m.type !== 'insert'))
      throw new UnsupportedMutationError(entity, m.type, mode)
    if (m.type === 'insert') return [{ entity, op: 'insert', data: writable(entity, m.modified) }]
    if (m.type === 'update') {
      const changes = writable(entity, m.changes)
      return Object.keys(changes).length ? [{ entity, op: 'update', id: keyOf(m.key), data: changes }] : []
    }
    return [{ entity, op: 'delete', id: keyOf(m.key) }]
  })
}

interface BatchResult {
  results: Array<{ entity: string; op: 'insert' | 'update' | 'delete'; id: number | string; row?: { id: number | string } }>
}

/**
 * Direct writes need a running sync: an idle or cleaned-up collection (e.g.
 * right after a sign-in reset) throws on writeUpsert/writeDelete. Such a
 * collection loads fresh server state the next time it is used, so the write
 * can simply be skipped.
 */
export const isSyncing = (c: AnyCollection | undefined): c is AnyCollection =>
  !!c && c.status !== 'idle' && c.status !== 'cleaned-up'

const utilsOf = (entity: string) => {
  const c = BY_ENTITY[entity]
  return isSyncing(c) ? (c.utils as SyncUtils) : undefined
}

/** Whether a server row (already derived) carries nothing new over the synced row. */
export function sameRow(next: Record<string, unknown>, synced: unknown) {
  if (!synced || typeof synced !== 'object') return false
  const current = synced as Record<string, unknown>
  return Object.keys(next).every((k) => {
    const a = next[k]
    const b = current[k]
    return a === b || (typeof a === 'object' && a !== null && JSON.stringify(a) === JSON.stringify(b))
  })
}

/**
 * Hook for every server version of a row about to be written into the synced
 * store (batch results and SSE): live alerts compare it with the synced row.
 */
export function landing(entity: string, row: { id: number | string } & Record<string, any>, opts: { created?: boolean } = {}) {
  if (entity !== 'customers') return
  const synced = BY_ENTITY.customers?.base.get(row.id) as CustomerRow | undefined
  customerAlertsDetector.landed(row as CustomerRow, synced, opts)
}

async function writeResults(results: BatchResult['results']) {
  const byEntity = new Map<string, BatchResult['results']>()
  for (const r of results) byEntity.set(r.entity, [...(byEntity.get(r.entity) ?? []), r])
  for (const entity of byEntity.keys()) aggregatesChanged(entity)
  await Promise.all(
    [...byEntity].map(async ([entity, rs]) => {
      const collection = BY_ENTITY[entity]
      const utils = utilsOf(entity)
      const derive = DERIVE[entity] ?? ((r: unknown) => r)
      // last write per key wins (a row can appear twice, e.g. written and re-read)
      const upserts = new Map(rs.filter((r) => r.op !== 'delete' && r.row).map((r) => [r.id, r]))
      const created = new Set(rs.filter((r) => r.op === 'insert').map((r) => r.id))
      for (const r of upserts.values()) landing(entity, r.row!, { created: created.has(r.id) })
      if (!utils || !collection) return
      // a row the synced store already holds as-is (e.g. the change feed was faster) needs no write
      const rows = [...upserts.values()].map((r) => derive(r.row!)).filter((row) => !sameRow(row, collection.base.get(row.id)))
      // since query-db-collection 1.4 direct writes report validation failures by
      // rejecting (not throwing), so every inner write promise is awaited too
      const inner: Array<Promise<void>> = []
      await Promise.all([
        rows.length
          ? utils
              .writeBatch(() => {
                for (const row of rows) inner.push(utils.writeUpsert(row))
              })
              .then(() => Promise.all(inner))
          : undefined,
        // the SSE echo may already have removed the row; that's fine
        ...rs.filter((r) => r.op === 'delete').map((r) => utils.writeDelete(r.id).catch(() => {})),
      ])
    }),
  )
}

/** Send mutations to the server atomically and reconcile synced state with the response. */
export async function persist(mutations: ReadonlyArray<PendingMutation<any>>) {
  // throws (rolling the transaction back) before anything is sent if an op is not allowed
  const ops = toBatchOps(mutations)
  let results: BatchResult['results'] = []
  if (ops.length) {
    // a 401 here is handled centrally by the API client (sign-out + redirect)
    results = (await api.post<BatchResult>('/batch', { ops })).results
  }
  // From here on the server has committed: the transaction must not be reported
  // as failed. If reconciling local state goes wrong, log it and resync the
  // affected collections from the server instead.
  try {
    await reconcile(mutations, results)
  } catch (e) {
    console.error('[persist] the server committed, but reconciling local state failed — refetching', e)
    const entities = new Set([
      ...results.map((r) => r.entity),
      ...mutations.flatMap((m) => ENTITY_OF.get(m.collection as AnyCollection) ?? []),
    ])
    const syncing = [...entities].flatMap((entity) => utilsOf(entity) ?? [])
    await Promise.all(syncing.map((utils) => utils.refetch().catch(() => {})))
  }
}

async function reconcile(mutations: ReadonlyArray<PendingMutation<any>>, committed: BatchResult['results']) {
  const results = [...committed]
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
 * Eager collections load a whole table in one request, capped by the server
 * at 10,000 rows (MAX_PAGE_SIZE). Past that the table would be silently
 * truncated — every local aggregate would be wrong — so say so loudly. Only
 * small, bounded tables are eager; the big ones are on-demand below.
 */
async function fetchAll<T>(entity: string, params: QueryParams | undefined, signal: AbortSignal) {
  const page = await api.get<Page<T>>(`/${entity}`, { limit: MAX_ROWS, ...params }, signal)
  if (page.total > page.data.length)
    console.error(
      `[collections] ${entity}: loaded ${page.data.length} of ${page.total} rows — the eager collection is truncated; ` +
        'make it on-demand',
    )
  return page.data
}

/**
 * Eager collection for a server resource: loads the whole table once, then
 * every filter/sort/join/aggregate runs locally. The resource's server-side
 * mode decides which handlers exist — an append-only collection simply has no
 * onUpdate/onDelete, so `collection.update()` throws before anything happens.
 */
function serverCollection<T extends object, K extends string | number>(
  entity: string,
  getKey: (row: T) => K,
  opts: { mode?: Mode; params?: QueryParams; map?: (row: any) => T } = {},
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
        const rows = await fetchAll<T>(entity, opts.params, signal)
        return opts.map ? rows.map(opts.map) : rows
      },
      ...(mode !== 'read-only' && { onInsert: save }),
      ...(mode === 'crud' && { onUpdate: save, onDelete: save }),
    }),
  )
  register(collection as AnyCollection, entity, mode)
  return collection
}

/** Thrown (and logged) when an on-demand subset with no limit matches more rows than one request returns. */
export class SubsetTooLargeError extends Error {
  constructor(entity: string, total: number) {
    super(`${entity}: an unbounded subset matched ${total} rows (more than ${MAX_ROWS}) — add a limit or a narrower filter`)
    this.name = 'SubsetTooLargeError'
  }
}

/**
 * On-demand collection: nothing is loaded up front. Each live query's
 * where/orderBy/limit/offset is pushed down to the REST API (see pushdown.ts),
 * identical or overlapping requests are deduplicated, and a subset's rows
 * leave the collection again when no live query needs them.
 *
 * Writes work like on eager collections (one atomic batch, canonical rows
 * written back), with one library difference: after a direct write the query
 * collection re-reads every *active* window of the collection, because a
 * changed row can move into or out of a window that only the server can
 * refill (@tanstack/query-db-collection ≥ 1.3, #1826).
 */
function onDemandCollection<T extends object, K extends string | number>(
  entity: string,
  getKey: (row: T) => K,
  opts: {
    id?: string
    scope?: Record<string, string>
    /** what the server accepts (mirrors server/resources.ts); defaults to read-only */
    mode?: Mode
    map?: (row: any) => T
    /** derived search/sort fields the rows carry */
    pushdown?: PushdownSpec
    /** sources the row mapping reads (e.g. users for the owner name) */
    before?: () => Promise<unknown>
    /** serves unfiltered newest-first windows from a cursor-paginated endpoint instead */
    pager?: CursorPager<T>
  } = {},
) {
  const mode = opts.mode ?? 'read-only'
  let self: AnyCollection | undefined
  const collection = createCollection(
    queryCollectionOptions({
      id: opts.id ?? entity,
      // business scope goes into the key (and every request); the subset identity is appended per live query
      queryKey: opts.scope ? [entity, opts.scope] : [entity],
      queryClient,
      syncMode: 'on-demand',
      getKey,
      // windows are kept fresh by the change feed (live.ts), not by polling
      staleTime: 5 * 60_000,
      ...indexing,
      // order strings like SQLite does (byte order), so pushed-down windows are the same rows
      defaultStringCollation: { stringSort: 'lexical' },
      queryFn: async (ctx) => {
        const subset = ctx.meta?.loadSubsetOptions
        if (opts.pager && isNewestFirstWindow(subset))
          return opts.pager.read({ offset: subset.offset, limit: subset.limit }, ctx.signal)
        // A by-key lookup of a row we already hold — typically the tie request TanStack DB sends
        // after every ordered window, for the window's own last row — is answered from the synced
        // store instead of a second round trip. (The live query re-applies its filter anyway.)
        const lookup = subset?.limit === undefined ? uniqueLookup(subset?.where) : undefined
        if (lookup) {
          const row = self?.base.get(lookup.id) as { order?: Record<string, string> } | undefined
          if (row && (!lookup.field || row.order?.[lookup.field] === lookup.key)) return [row as T]
        }
        const search = loadSubsetToSearch(subset, opts.pushdown)
        for (const [k, v] of Object.entries(opts.scope ?? {})) search.set(k, v)
        // Deliberately not wired to ctx.signal: TanStack Query only aborts a query whose fn
        // consumed the signal. An aborted window (the user clicked on before it arrived) is a
        // *failed* acquisition for TanStack DB's ordered loader, which then "repairs" it with a
        // full-source load — the unbounded where-only request we refuse at scale. A window that
        // finishes in the background just lands in the cache (and serves the next visit).
        const [page] = await Promise.all([api.get<Page<T>>(`/${entity}`, Object.fromEntries(search)), opts.before?.()])
        // an unbounded subset is "every matching row": refuse instead of returning a truncated set
        if (subset?.limit === undefined && page.total > page.data.length) {
          const error = new SubsetTooLargeError(entity, page.total)
          console.error(`[collections] ${error.message}`, subset)
          throw error
        }
        return opts.map ? page.data.map(opts.map) : page.data
      },
      ...(mode !== 'read-only' && { onInsert: save }),
      ...(mode === 'crud' && { onUpdate: save, onDelete: save }),
    }),
  )
  self = collection as AnyCollection
  if (!opts.id) register(collection as AnyCollection, entity, mode)
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
/** 250k rows at scale: on-demand windows; search and every sort column pushed down via derived fields */
export const customersCollection = onDemandCollection<CustomerRow, number>('customers', (c) => c.id, {
  mode: 'crud', // archive = soft delete on the server
  map: withCustomerDerived,
  pushdown: { search: 'searchText', sorts: CUSTOMER_SORTS },
  // the owner name (search, sort) comes from the users collection
  before: () => usersCollection.toArrayWhenReady(),
})
export const contactsCollection = onDemandCollection<Contact, number>('contacts', (c) => c.id, { mode: 'crud' })
export const tagsCollection = serverCollection<Tag, number>('tags', (t) => t.id)
export const customerTagsCollection = onDemandCollection<CustomerTag, string>('customer-tags', (t) => t.id, { mode: 'crud' })

// ============================== catalog & billing ==============================
export const productsCollection = serverCollection<Product, number>('products', (p) => p.id)
export const subscriptionsCollection = onDemandCollection<Subscription, number>('subscriptions', (s) => s.id, { mode: 'crud' })
/** 1.1M rows at scale: on-demand; the server joins in the customer company (search, sort, display) */
export const invoicesCollection = onDemandCollection<InvoiceRow, number>('invoices', (i) => i.id, {
  mode: 'crud', // status changes only; the server refuses creates/deletes
  map: withInvoiceDerived,
  pushdown: { search: 'searchText', sorts: INVOICE_SORTS },
})
export const mrrSnapshotsCollection = serverCollection<MrrSnapshot, string>('mrr-snapshots', (s) => s.id, { mode: 'read-only' })
/** the payment ledger is large (1.1M rows at scale) and append-only: windows on demand, insert-only */
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
    queryFn: ({ signal }) => fetchAll<TaskRow>('tasks', undefined, signal),
    onInsert: save,
    onUpdate: save,
    onDelete: save,
  }),
)
register(tasksCollection as AnyCollection, 'tasks', 'crud')

/** append-only: no update/delete handlers, validated by an Effect Schema */
export const commentsCollection = createCollection(
  queryCollectionOptions({
    id: 'task-comments',
    queryKey: ['task-comments'],
    queryClient,
    schema: Schema.toStandardSchemaV1(CommentSchema),
    getKey: (c: TaskComment) => c.id,
    ...indexing,
    queryFn: ({ signal }) => fetchAll<TaskComment>('task-comments', undefined, signal),
    onInsert: save,
  }),
)
register(commentsCollection as AnyCollection, 'task-comments', 'append-only')

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
/**
 * The activity log only grows at the head, so offset windows drift (a new event
 * shifts every page by one). The server's keyset feed (`/events/feed?cursor=`)
 * doesn't, but it only speaks opaque cursors. `createCursorPager` bridges the
 * two: live queries still ask for `offset/limit` windows; the pager serves them
 * from cached cursor pages owned by TanStack Query. Filtered windows (e.g. one
 * customer's events) still go to the regular list endpoint.
 */
const FEED_PAGE = 50
const feedPager = (type?: string) =>
  createCursorPager<ActivityEvent>({
    queryClient,
    // its own root key: manual writes to the row collections update their whole prefix
    queryKey: ['event-feed-pages', type ?? 'all'],
    staleTime: 30_000,
    fetchPage: async (cursor, signal) => {
      const page = await api.get<{ data: ActivityEvent[]; nextCursor: number | null }>(
        '/events/feed',
        { limit: FEED_PAGE, ...(cursor && { cursor }), ...(type && { type }) },
        signal,
      )
      return { rows: page.data, nextCursor: page.nextCursor === null ? null : String(page.nextCursor) }
    },
  })
export const FEED_PAGERS: Array<CursorPager<ActivityEvent>> = []
const withPager = (type?: string) => {
  const pager = feedPager(type)
  FEED_PAGERS.push(pager)
  return pager
}

/** The whole activity log (on-demand). */
export const eventsCollection = onDemandCollection<ActivityEvent, number>('events', (e) => e.id, { pager: withPager() })
/**
 * Business-scoped collection factory: one on-demand collection per category.
 * The scope is a fixed part of every request, so live queries over it need no
 * `where` and their windows are served by that category's cursor feed.
 */
export const eventsByCategory = Object.fromEntries(
  EVENT_CATEGORIES.map((c) => [
    c,
    onDemandCollection<ActivityEvent, number>('events', (e) => e.id, {
      id: `events:${c}`,
      scope: { 'category[eq]': c },
      pager: withPager(`${c}.`), // the feed filters by type prefix: "invoice." = the invoice category
    }),
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
/** Eager collections a signed-in session needs for most pages (all small and bounded). */
export const CORE = [usersCollection, projectsCollection, tasksCollection] as const

export const preloadAll = () => Promise.all(CORE.map((c) => c.preload()))

/**
 * Sign-in / sign-out: drop every server-backed collection's rows and cache so
 * nothing from the previous user can leak into the next session.
 */
export async function resetServerCollections() {
  const all = [...Object.values(BY_ENTITY), ...Object.values(eventsByCategory)]
  await Promise.all(all.map((c) => c.cleanup()))
  for (const p of FEED_PAGERS) p.reset()
  customerAlertsDetector.reset()
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' })
  // in-memory UI state that refers to the previous user's rows
  if (selectionCollection.size) selectionCollection.delete([...selectionCollection.keys()])
}

/**
 * Pins live in localStorage, which outlives sessions. Remember whose pins they
 * are and drop them when a different user signs in on this browser.
 * (Preferences such as the theme are per-browser and stay.)
 */
const CLIENT_STATE_OWNER = 'saasly:client-state-owner'
export function claimClientState(userId: number) {
  let previous: string | null = null
  try {
    previous = localStorage.getItem(CLIENT_STATE_OWNER)
    if (previous === String(userId)) return
    localStorage.setItem(CLIENT_STATE_OWNER, String(userId))
  } catch {
    return // storage unavailable: nothing persisted to leak either
  }
  if (previous !== null && pinsCollection.size) pinsCollection.delete([...pinsCollection.keys()])
}

/** Client-side id generation: rows get their final id before the server sees them (no temp-id swap). */
let lastId = 0
export function newId() {
  // ms timestamp * 1000 + random 0..999 (so two clients in the same millisecond almost never
  // collide), bumped to stay strictly increasing within this tab; ≈1.8e15, well under the
  // server's 2^52 cap for client ids
  const base = Date.now() * 1000 + Math.floor(Math.random() * 1000)
  lastId = Math.max(lastId + 1, base)
  return lastId
}
