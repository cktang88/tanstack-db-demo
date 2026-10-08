import {
  count,
  createCollection,
  createLiveQueryCollection,
  eq,
  IR,
  localOnlyCollectionOptions,
  SchemaValidationError,
  sum,
  type PendingMutation,
} from '@tanstack/react-db'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { predictMrr } from '../../src/db/actions'
import {
  auditCollection,
  commentsCollection,
  customersCollection,
  eventsCollection,
  invoicesCollection,
  newId,
  paymentsCollection,
  persist,
  resetServerCollections,
  selectionCollection,
  teamMembersCollection,
  tasksCollection,
  toBatchOps,
  UnsupportedMutationError,
  usersCollection,
  withInvoiceDerived,
} from '../../src/db/collections'
import { applyChange } from '../../src/db/live'
import {
  isNewestFirstWindow,
  loadSubsetToSearch,
  MAX_ROWS,
  orderByToSort,
  searchPattern,
  sortKey,
  uniqueLookup,
  whereToParams,
} from '../../src/db/pushdown'
import { api, HttpError, onUnauthorized } from '../../src/lib/api'

const ref = (field: string) => new IR.PropRef([field])
const val = (v: unknown) => new IR.Value(v)
const fn = (name: string, ...args: IR.BasicExpression[]) => new IR.Func(name, args)

describe('predicate push-down', () => {
  it('translates comparisons, IN, IS NULL and NOT into the REST grammar', () => {
    const where = fn(
      'and',
      fn('eq', ref('customerId'), val(7)),
      fn('in', ref('type'), val(['invoice.paid', 'invoice.created'])),
      fn('gte', ref('createdAt'), val(new Date('2026-01-01T00:00:00Z'))),
      fn('isNull', ref('actorId')),
      fn('not', fn('eq', ref('status'), val('void'))),
    )
    expect(whereToParams(where as never)).toEqual([
      ['customerId[eq]', '7'],
      ['type[in]', 'invoice.paid,invoice.created'],
      ['createdAt[gte]', '2026-01-01T00:00:00.000Z'],
      ['actorId[isNull]', ''],
      ['status[neq]', 'void'],
    ])
  })

  it('builds sort, limit and offset', () => {
    const orderBy = [
      { expression: ref('createdAt'), compareOptions: { direction: 'desc', nulls: 'last', stringSort: 'lexical' } },
      { expression: ref('id'), compareOptions: { direction: 'asc', nulls: 'first', stringSort: 'lexical' } },
    ]
    const sp = loadSubsetToSearch({ where: fn('eq', ref('category'), val('task')), orderBy, limit: 31, offset: 30 } as never)
    expect(decodeURIComponent(sp.toString())).toBe('category[eq]=task&sort=-createdAt,id&limit=31&offset=30')
  })

  it('asks for everything when the subset is unbounded (the caller refuses a truncated answer)', () => {
    expect(loadSubsetToSearch({} as never).get('limit')).toBe('10000')
    // order only matters to cut a window: an unbounded subset is sorted locally, so no sort is sent
    // (and none is refused, e.g. a descending boolean with NULLs first)
    const byPrimary = [{ expression: ref('isPrimary'), compareOptions: { direction: 'desc', nulls: 'first' } }]
    expect(loadSubsetToSearch({ where: fn('eq', ref('customerId'), val(7)), orderBy: byPrimary } as never).toString()).toBe(
      'customerId%5Beq%5D=7&limit=10000',
    )
  })

  it('refuses a window deeper than the API serves instead of letting the server cap it', () => {
    expect(() => loadSubsetToSearch({ limit: MAX_ROWS + 1 } as never)).toThrow(/larger than the API serves/)
    expect(loadSubsetToSearch({ limit: MAX_ROWS } as never).get('limit')).toBe(String(MAX_ROWS))
  })

  it('refuses predicates the API cannot express instead of returning a wrong window', () => {
    expect(() => whereToParams(fn('or', fn('eq', ref('a'), val(1)), fn('eq', ref('b'), val(2))) as never)).toThrow()
    expect(() => whereToParams(fn('like', ref('a'), val('%x%')) as never)).toThrow()
    expect(() => whereToParams(fn('eq', new IR.PropRef(['a', 'b']), val(1)) as never)).toThrow(/Nested/)
  })

  it('refuses field-to-field comparisons and misplaced lists instead of sending a field name as a literal', () => {
    expect(() => whereToParams(fn('eq', ref('a'), ref('b')) as never)).toThrow(/literal/)
    expect(() => whereToParams(fn('and', fn('eq', ref('x'), val(1)), fn('gt', ref('a'), ref('b'))) as never)).toThrow()
    expect(() => whereToParams(fn('eq', val(1), ref('a')) as never)).toThrow(/field/)
    expect(() => whereToParams(fn('eq', ref('a'), val([1, 2])) as never)).toThrow(/list/)
    expect(() => whereToParams(fn('in', ref('a'), ref('b')) as never)).toThrow()
  })

  it("refuses sort orders SQLite wouldn't produce", () => {
    const by = (field: string, direction: 'asc' | 'desc', nulls: 'first' | 'last', stringSort = 'locale') => [
      { expression: ref(field), compareOptions: { direction, nulls, stringSort } },
    ]
    // SQLite: NULLs first ascending, last descending
    expect(orderByToSort(by('dueAt', 'asc', 'first') as never)).toBe('dueAt')
    expect(orderByToSort(by('dueAt', 'desc', 'last') as never)).toBe('-dueAt')
    expect(() => orderByToSort(by('dueAt', 'desc', 'first') as never)).toThrow(/NULLs/)
    expect(() => orderByToSort(by('dueAt', 'asc', 'last') as never)).toThrow(/NULLs/)
    // ids are never NULL: the default (nulls first) is fine in both directions
    expect(orderByToSort(by('id', 'desc', 'first') as never)).toBe('-id')
    expect(() => orderByToSort(by('name', 'asc', 'first', 'custom') as never)).toThrow(/custom/)
  })
})

describe('push-down of the server search and composite sort keys', () => {
  const spec = { search: 'searchText', sorts: { mrr: 'mrr', owner: 'owner', company: 'customerCompany' } }
  const order = (key: string) => new IR.PropRef(['order', key])
  const by = (key: string, direction: 'asc' | 'desc', stringSort = 'lexical') => [
    { expression: order(key), compareOptions: { direction, nulls: 'first', stringSort } },
  ]

  it("sends ilike over the derived search field as the server's ?q= (wildcards stay literal)", () => {
    const where = fn(
      'and',
      fn('in', ref('status'), val(['active'])),
      fn('ilike', ref('searchText'), val(searchPattern('Ac_me 50%'))),
    )
    expect(whereToParams(where as never, spec)).toEqual([
      ['status[in]', 'active'],
      ['q', 'ac_me 50%'],
    ])
  })

  it('refuses any other ilike/like: on another field, without a search field, or a hand-written pattern', () => {
    expect(() => whereToParams(fn('ilike', ref('company'), val('%x%')) as never, spec)).toThrow(/search field/)
    expect(() => whereToParams(fn('ilike', ref('searchText'), val('%x%')) as never)).toThrow(/search field/)
    expect(() => whereToParams(fn('ilike', ref('searchText'), val('x%')) as never, spec)).toThrow(/searchPattern/)
    expect(() => whereToParams(fn('ilike', ref('searchText'), val('%a%b%')) as never, spec)).toThrow(/searchPattern/)
    expect(() => whereToParams(fn('ilike', ref('searchText'), val('%a_b%')) as never, spec)).toThrow(/searchPattern/)
  })

  it('sorts by a composite key as <field>,id in one direction (a unique, exact window)', () => {
    expect(orderByToSort(by('mrr', 'desc') as never, spec)).toBe('-mrr,-id')
    expect(orderByToSort(by('owner', 'asc') as never, spec)).toBe('owner,id')
    expect(orderByToSort(by('company', 'asc') as never, spec)).toBe('customerCompany,id')
    // locale collation would cut a different window than SQLite's byte order
    expect(() => orderByToSort(by('mrr', 'desc', 'locale') as never, spec)).toThrow(/lexically/)
    expect(() => orderByToSort(by('seats', 'desc') as never, spec)).toThrow(/Unknown sort key/)
  })

  it("turns the loader's tie request on a sort key into that one row, and refuses ranges over it", () => {
    const tie = fn('and', fn('eq', ref('status'), val('active')), fn('eq', order('mrr'), val(sortKey(12_900, 42))))
    expect(whereToParams(tie as never, spec)).toEqual([
      ['status[eq]', 'active'],
      ['id[eq]', '42'],
    ])
    expect(uniqueLookup(tie as never)).toEqual({ id: 42, field: 'mrr', key: sortKey(12_900, 42) })
    expect(uniqueLookup(fn('eq', ref('id'), val(7)) as never)).toEqual({ id: 7 })
    expect(uniqueLookup(fn('eq', ref('customerId'), val(7)) as never)).toBeUndefined()
    expect(() => whereToParams(fn('gt', order('mrr'), val(sortKey(1, 1))) as never, spec)).toThrow(/sort key/)
    expect(() => whereToParams(fn('eq', order('seats'), val(sortKey(1, 1))) as never, spec)).toThrow(/Unknown sort key/)
  })

  it("orders sort keys exactly like SQLite's ORDER BY value, id (NULLs first, byte order, numbers)", async () => {
    const { default: Database } = await import('better-sqlite3')
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT, n INTEGER)')
    const rows: Array<[number, string | null, number | null]> = [
      [1, 'Acme', 5],
      [2, 'Acme Labs', -3],
      [3, null, 0],
      [4, 'acme', 5],
      [5, 'Acme', 1_000_000],
      [6, '', null],
      [7, 'Zeta', 12],
      [8, 'Acme', -3],
      [9, 'Ácme', 7],
      [10, null, 5],
    ]
    const insert = db.prepare('INSERT INTO t VALUES (?, ?, ?)')
    for (const r of rows) insert.run(...r)
    const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
    for (const col of ['s', 'n'] as const) {
      for (const dir of ['ASC', 'DESC'] as const) {
        const sqlite = (db.prepare(`SELECT id FROM t ORDER BY ${col} ${dir}, id ${dir}`).all() as Array<{ id: number }>).map(
          (r) => r.id,
        )
        const keys = rows.map(([id, s, n]) => ({ id, key: sortKey(col === 's' ? s : n, id) }))
        keys.sort((a, b) => (dir === 'ASC' ? 1 : -1) * lexical(a.key, b.key))
        expect(keys.map((k) => k.id)).toEqual(sqlite)
      }
    }
  })
})

describe('cursor feed windows', () => {
  const byId = (direction: 'asc' | 'desc') => [
    { expression: ref('id'), compareOptions: { direction, nulls: 'last' as const, stringSort: 'lexical' as const } },
  ]
  it('only routes unfiltered, bounded, newest-first windows to the cursor pager', () => {
    expect(isNewestFirstWindow({ orderBy: byId('desc'), limit: 30, offset: 31 } as never)).toBe(true)
    expect(isNewestFirstWindow({ orderBy: byId('asc'), limit: 30 } as never)).toBe(false)
    expect(isNewestFirstWindow({ orderBy: byId('desc') } as never)).toBe(false)
    expect(isNewestFirstWindow({ where: fn('eq', ref('customerId'), val(7)), orderBy: byId('desc'), limit: 20 } as never)).toBe(
      false,
    )
  })
})

describe('batch op mapping', () => {
  const m = (over: Partial<PendingMutation<any>>) =>
    ({ collection: customersCollection, metadata: undefined, ...over }) as PendingMutation<any>

  it('maps collection mutations to server batch ops, dropping derived & server-computed fields', () => {
    const ops = toBatchOps([
      m({
        type: 'insert',
        key: 1,
        modified: { id: 1, company: 'X', createdMonth: '2026-01', mrr: 500, teamId: null, createdAt: 'now', updatedAt: 'now' },
      }),
      m({ type: 'update', key: 2, changes: { seats: 3, mrr: 10, updatedAt: 'now', createdMonth: '2026-02' } }),
      m({ type: 'update', key: 3, changes: { updatedAt: 'now' } }),
      m({ type: 'delete', key: 4 }),
      m({ type: 'delete', key: 5, metadata: { cascade: true } }),
      m({ type: 'update', key: 6, changes: { role: 'admin' }, collection: usersCollection as never }),
    ])
    expect(ops).toEqual([
      { entity: 'customers', op: 'insert', data: { id: 1, company: 'X' } },
      { entity: 'customers', op: 'update', id: 2, data: { seats: 3 } },
      { entity: 'customers', op: 'delete', id: 4 },
      { entity: 'users', op: 'update', id: 6, data: { role: 'admin' } },
    ])
  })

  it('skips server-derived echoes and keeps string keys of join tables', () => {
    const ops = toBatchOps([
      // payment settles the invoice: the server's trigger does that, so the optimistic patch is not sent
      m({
        type: 'update',
        key: 7,
        changes: { status: 'paid' },
        metadata: { derived: true },
        collection: invoicesCollection as never,
      }),
      m({
        type: 'insert',
        key: 9,
        modified: {
          id: 9,
          invoiceId: 7,
          customerId: 3,
          amount: 100,
          method: 'card',
          reference: '',
          receivedAt: 'now',
          recordedBy: 1,
        },
        collection: paymentsCollection as never,
      }),
      m({ type: 'delete', key: '1:4', collection: teamMembersCollection as never }),
    ])
    expect(ops).toEqual([
      // the reference, timestamp and recorder are generated by the server — never stored from the client
      { entity: 'payments', op: 'insert', data: { id: 9, invoiceId: 7, amount: 100, method: 'card' } },
      { entity: 'team-members', op: 'delete', id: '1:4' },
    ])
  })

  it('refuses updates/deletes of append-only resources and any write to read-only ones before sending', () => {
    // inside an ambient transaction collection.update() doesn't check for handlers — toBatchOps does
    const comment = { collection: commentsCollection as never }
    expect(
      toBatchOps([m({ type: 'insert', key: 1, modified: { id: 1, taskId: 2, body: 'hi', authorId: 5 }, ...comment })]),
    ).toEqual([{ entity: 'task-comments', op: 'insert', data: { id: 1, taskId: 2, body: 'hi' } }])
    expect(() => toBatchOps([m({ type: 'update', key: 1, changes: { body: 'edited' }, ...comment })])).toThrow(
      UnsupportedMutationError,
    )
    expect(() => toBatchOps([m({ type: 'delete', key: 9, collection: paymentsCollection as never })])).toThrow(/append-only/)
    expect(() => toBatchOps([m({ type: 'insert', key: 1, modified: { id: 1 }, collection: auditCollection as never })])).toThrow(
      /read-only/,
    )
    // a provisional (derived) row in a read-only collection is never sent, so it is fine
    expect(
      toBatchOps([
        m({ type: 'insert', key: 1, modified: { id: 1 }, metadata: { derived: true }, collection: eventsCollection as never }),
      ]),
    ).toEqual([])
  })

  it('ignores mutations on local-only collections', () => {
    const local = createCollection(localOnlyCollectionOptions({ id: 'x', getKey: (r: { id: number }) => r.id }))
    expect(toBatchOps([m({ type: 'insert', key: 1, modified: { id: 1 }, collection: local as never })])).toEqual([])
  })
})

describe('collections', () => {
  afterEach(() => vi.restoreAllMocks())

  it('derives month buckets for invoices', () => {
    const inv = withInvoiceDerived({
      id: 1,
      number: 'I',
      customerId: 1,
      amount: 5,
      status: 'paid',
      issuedAt: '2026-03-30T00:00:00Z',
      dueAt: '',
      paidAt: '2026-04-02T00:00:00Z',
    })
    expect(inv).toMatchObject({ issuedMonth: '2026-03', paidMonth: '2026-04' })
    expect(withInvoiceDerived({ ...inv, status: 'open', paidAt: null }).paidMonth).toBeNull()
  })

  it('generates unique, increasing, safe-integer ids', () => {
    const ids = Array.from({ length: 1000 }, newId)
    expect(new Set(ids).size).toBe(1000)
    expect(ids.every((id, i) => Number.isSafeInteger(id) && (i === 0 || id > ids[i - 1]!))).toBe(true)
  })

  it('validates task inserts with the Effect Schema before anything happens', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [] }))
    const bad = () =>
      tasksCollection.insert({
        id: 1,
        projectId: 1,
        title: 'no',
        status: 'todo',
        priority: 'low',
        assigneeId: null,
        dueDate: null,
        position: 1,
        createdAt: '',
        updatedAt: '',
      })
    expect(bad).toThrow(SchemaValidationError)
    try {
      bad()
    } catch (e) {
      expect((e as SchemaValidationError).issues[0]?.message).toBe('Title must be at least 3 characters')
    }
  })
})

describe('persist', () => {
  afterEach(() => vi.restoreAllMocks())
  const m = (over: Partial<PendingMutation<any>>) =>
    ({ collection: customersCollection, metadata: undefined, ...over }) as PendingMutation<any>

  it('never reports a committed batch as failed when reconciling local state goes wrong', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) =>
      init?.method === 'POST'
        ? Response.json({ results: [{ entity: 'payments', op: 'insert', id: 9, row: { id: 9 } }] })
        : // the derived re-read of the invoice fails
          Response.json({ error: 'Boom', message: 'boom' }, { status: 500 }),
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      persist([
        m({
          type: 'insert',
          key: 9,
          modified: { id: 9, invoiceId: 7, amount: 1, method: 'card' },
          collection: paymentsCollection as never,
        }),
        m({
          type: 'update',
          key: 7,
          changes: { status: 'paid' },
          metadata: { derived: true },
          collection: invoicesCollection as never,
        }),
      ]),
    ).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('the server committed'), expect.any(HttpError))
  })

  it('rejects without a request when an op is not allowed, and reports 401s centrally', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    await expect(persist([m({ type: 'delete', key: 1, collection: commentsCollection as never })])).rejects.toThrow(
      UnsupportedMutationError,
    )
    expect(fetch).not.toHaveBeenCalled()
    const handler = vi.fn()
    onUnauthorized(handler)
    await expect(persist([m({ type: 'update', key: 1, changes: { seats: 2 } })])).rejects.toThrow(HttpError)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }))
    // any other request too (one-off calls like mark-all-read), but not a failed sign-in
    handler.mockClear()
    await expect(api.post('/notifications/read-all', {})).rejects.toThrow(HttpError)
    expect(handler).toHaveBeenCalledTimes(1)
    await expect(api.post('/auth/login', { email: 'x', password: 'y' })).rejects.toThrow(HttpError)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('sign-in/out reset', () => {
  afterEach(() => vi.restoreAllMocks())
  const customer = {
    id: 1,
    name: 'Ada',
    email: 'a@x.io',
    company: 'Acme',
    plan: 'pro',
    status: 'active',
    country: 'US',
    seats: 2,
    mrr: 100,
    ownerId: null,
    teamId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }

  it('clears every collection and the selection, and the next session loads fresh rows', async () => {
    let rows = [customer]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: rows, total: rows.length }))
    await usersCollection.preload()
    expect(usersCollection.size).toBe(1)
    selectionCollection.insert({ id: 1 })

    await resetServerCollections()
    expect(selectionCollection.size).toBe(0)
    expect(usersCollection.status).toBe('cleaned-up')

    // the next session's data, not the previous session's rows
    rows = [{ ...customer, id: 2 }]
    await usersCollection.preload()
    expect([...usersCollection.keys()]).toEqual([2])
    await resetServerCollections()
  })

  it('drops live changes for collections that are not syncing instead of throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: [], total: 0 }))
    await resetServerCollections()
    const event = { id: 5, type: 'invoice.paid', category: 'invoice', actorId: null, customerId: 1, message: 'x', createdAt: '' }
    expect(() => applyChange({ kind: 'upsert', entity: 'events', row: event })).not.toThrow()
    expect(() => applyChange({ kind: 'upsert', entity: 'customers', row: customer })).not.toThrow()
    expect(() => applyChange({ kind: 'delete', entity: 'customers', id: 1 })).not.toThrow()
    expect(customersCollection.status).toBe('cleaned-up')
  })

  it('writes live changes into a syncing eager collection', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: [], total: 0 }))
    await usersCollection.preload()
    const user = { id: 3, name: 'Grace', email: 'g@x.io', role: 'admin', title: 'CTO', avatarColor: '#000', active: true }
    await applyChange({ kind: 'upsert', entity: 'users', row: user })
    expect(usersCollection.get(3)).toMatchObject({ name: 'Grace' })
    await resetServerCollections()
  })
})

describe('optimistic MRR', () => {
  it('moves the known MRR by the base-plan delta when subscriptions are not loaded', () => {
    const before = { id: 1, plan: 'pro' as const, seats: 10, status: 'active' as const, mrr: 123_456 }
    // keeps add-ons and the sold price already folded into the known MRR
    expect(predictMrr(before, { plan: 'pro', seats: 12, status: 'active' }) - before.mrr).toBe(
      predictMrr({ ...before, mrr: 0 }, { plan: 'pro', seats: 12, status: 'active' }),
    )
    expect(predictMrr(before, { plan: 'pro', seats: 10, status: 'churned' })).toBe(0)
    expect(predictMrr(before, { plan: 'pro', seats: 10, status: 'trial' })).toBe(0)
  })
})

describe('live queries are incrementally maintained', () => {
  it('keeps a GROUP BY aggregate in sync with inserts, updates and deletes', async () => {
    type Row = { id: number; team: string; points: number }
    const rows = createCollection(localOnlyCollectionOptions({ id: 'agg-test', getKey: (r: Row) => r.id }))
    const totals = createLiveQueryCollection((q) =>
      q
        .from({ r: rows })
        .groupBy(({ r }) => r.team)
        .select(({ r }) => ({ team: r.team, n: count(r.id), points: sum(r.points) })),
    )
    await totals.preload()
    rows.insert([
      { id: 1, team: 'a', points: 3 },
      { id: 2, team: 'a', points: 4 },
      { id: 3, team: 'b', points: 10 },
    ])
    const snapshot = () => Object.fromEntries(totals.toArray.map((t) => [t.team, [t.n, t.points]]))
    expect(snapshot()).toEqual({ a: [2, 7], b: [1, 10] })
    rows.update(2, (d) => void (d.team = 'b'))
    expect(snapshot()).toEqual({ a: [1, 3], b: [2, 14] })
    rows.delete(1)
    expect(snapshot()).toEqual({ b: [2, 14] })
  })

  it('joins two collections and filters on both sides', async () => {
    const a = createCollection(localOnlyCollectionOptions({ id: 'join-a', getKey: (r: { id: number; bId: number }) => r.id }))
    const b = createCollection(localOnlyCollectionOptions({ id: 'join-b', getKey: (r: { id: number; ok: boolean }) => r.id }))
    const joined = createLiveQueryCollection((q) =>
      q
        .from({ a })
        .innerJoin({ b }, ({ a, b }) => eq(a.bId, b.id))
        .where(({ b }) => eq(b.ok, true))
        .select(({ a, b }) => ({ id: a.id, bId: b.id })),
    )
    await joined.preload()
    b.insert([
      { id: 10, ok: true },
      { id: 11, ok: false },
    ])
    a.insert([
      { id: 1, bId: 10 },
      { id: 2, bId: 11 },
    ])
    expect(joined.toArray).toEqual([expect.objectContaining({ id: 1, bId: 10 })])
    b.update(11, (d) => void (d.ok = true))
    expect(joined.toArray.map((r) => r.id).sort((x, y) => x - y)).toEqual([1, 2])
  })
})
