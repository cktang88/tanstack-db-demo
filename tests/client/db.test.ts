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
import {
  customersCollection,
  invoicesCollection,
  newId,
  paymentsCollection,
  teamMembersCollection,
  tasksCollection,
  toBatchOps,
  usersCollection,
  withInvoiceDerived,
} from '../../src/db/collections'
import { isNewestFirstWindow, loadSubsetToSearch, orderByToSort, whereToParams } from '../../src/db/pushdown'

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

  it('asks for everything when the subset is unbounded', () => {
    expect(loadSubsetToSearch({} as never).get('limit')).toBe('10000')
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

  it('maps collection mutations to server batch ops, dropping derived & timestamp fields', () => {
    const ops = toBatchOps([
      m({ type: 'insert', key: 1, modified: { id: 1, company: 'X', createdMonth: '2026-01' } }),
      m({ type: 'update', key: 2, changes: { seats: 3, mrr: 10, updatedAt: 'now', createdMonth: '2026-02' } }),
      m({ type: 'update', key: 3, changes: { updatedAt: 'now' } }),
      m({ type: 'delete', key: 4 }),
      m({ type: 'delete', key: 5, metadata: { cascade: true } }),
      m({ type: 'update', key: 6, changes: { role: 'admin' }, collection: usersCollection as never }),
    ])
    expect(ops).toEqual([
      { entity: 'customers', op: 'insert', data: { id: 1, company: 'X' } },
      { entity: 'customers', op: 'update', id: 2, data: { seats: 3, mrr: 10 } },
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
      m({ type: 'insert', key: 9, modified: { id: 9, invoiceId: 7, amount: 100 }, collection: paymentsCollection as never }),
      m({ type: 'delete', key: '1:4', collection: teamMembersCollection as never }),
    ])
    expect(ops).toEqual([
      { entity: 'payments', op: 'insert', data: { id: 9, invoiceId: 7, amount: 100 } },
      { entity: 'team-members', op: 'delete', id: '1:4' },
    ])
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
