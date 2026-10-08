import { createCollection, createLiveQueryCollection, eq, ilike, localOnlyCollectionOptions } from '@tanstack/react-db'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Customer } from '../../shared/domain'
import { createCustomerAlerts } from '../../src/db/alerts'
import { customersCollection, resetServerCollections, SubsetTooLargeError } from '../../src/db/collections'
import { applyChange } from '../../src/db/live'
import { searchPattern, searchText } from '../../src/db/pushdown'

// The big tables are on-demand collections. These tests run live queries over
// the real customers collection against a tiny fake of the REST list grammar.

const customer = (id: number, over: Partial<Customer> = {}): Customer => ({
  id,
  name: `Contact ${id}`,
  email: `c${id}@x.io`,
  company: `Company ${id}`,
  plan: 'pro',
  status: 'active',
  country: 'US',
  seats: 1,
  mrr: id * 100,
  ownerId: 1,
  teamId: null,
  createdAt: `2026-01-0${id}T00:00:00Z`,
  updatedAt: `2026-01-0${id}T00:00:00Z`,
  ...over,
})
const users = [{ id: 1, name: 'Ada Lovelace', email: 'ada@x.io', role: 'owner', title: '', avatarColor: '#000', active: true }]

/** A fake API: customers filtered by status/id, sorted by -mrr,-id, windowed; totals as the server returns them. */
function fakeApi(rows: Customer[]) {
  const calls: string[] = []
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input, 'http://x')
    calls.push(decodeURIComponent(url.pathname + url.search))
    if (url.pathname === '/api/users') return Response.json({ data: users, total: users.length })
    let data = rows.filter(
      (r) =>
        (!url.searchParams.get('status[eq]') || r.status === url.searchParams.get('status[eq]')) &&
        (!url.searchParams.get('id[eq]') || r.id === Number(url.searchParams.get('id[eq]'))),
    )
    const total = data.length
    if (url.searchParams.get('sort') === '-mrr,-id') data = [...data].sort((a, b) => b.mrr - a.mrr || b.id - a.id)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    data = data.slice(offset, offset + Number(url.searchParams.get('limit') ?? 25))
    return Response.json({ data, total })
  })
  return { calls, fetch, customers: () => calls.filter((c) => c.startsWith('/api/customers')) }
}

const topByMrr = (limit: number) =>
  createLiveQueryCollection((q) =>
    q
      .from({ c: customersCollection })
      .where(({ c }) => eq(c.status, 'active'))
      .orderBy(({ c }) => c.order.mrr, 'desc')
      .limit(limit),
  )

afterEach(async () => {
  await resetServerCollections()
  vi.restoreAllMocks()
})

describe('on-demand customers', () => {
  it('loads one exact window per live query; the tie request for its unique sort key needs no round trip', async () => {
    const api = fakeApi([customer(1), customer(2), customer(3), customer(4, { status: 'churned' })])
    const top = topByMrr(2)
    await top.preload()
    await vi.waitFor(() => expect(top.toArray.map((c) => c.id)).toEqual([3, 2]))
    await new Promise((r) => setTimeout(r, 20))
    expect(api.customers()).toEqual(['/api/customers?status[eq]=active&sort=-mrr,-id&limit=2'])
    // rows carry what the server would sort and search by
    expect(customersCollection.get(3)).toMatchObject({
      ownerName: 'Ada Lovelace',
      searchText: expect.stringContaining('ada lovelace'),
    })
    await top.cleanup()
  })

  it('refuses an unbounded subset that matches more rows than one request returns', async () => {
    const many = Array.from({ length: 3 }, (_, i) => customer(i + 1))
    const api = fakeApi(many)
    // the fake caps every answer at 2 rows but reports the real total, like the API's 10,000 cap
    api.fetch.mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input, 'http://x')
      if (url.pathname === '/api/users') return Response.json({ data: users, total: 1 })
      return Response.json({ data: many.slice(0, 2), total: many.length })
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const all = createLiveQueryCollection((q) => q.from({ c: customersCollection }).where(({ c }) => eq(c.plan, 'pro')))
    await expect(all.preload()).rejects.toThrow()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unbounded subset matched 3 rows'), expect.anything())
    expect(customersCollection.size).toBe(0)
    expect(new SubsetTooLargeError('customers', 3).message).toMatch(/more than 10000/)
    await all.cleanup().catch(() => {})
  })

  it('writes a pushed change of a loaded row in place, and re-reads the windows for a row it does not hold', async () => {
    const rows = [customer(1), customer(2), customer(3)]
    const api = fakeApi(rows)
    const top = topByMrr(2)
    await top.preload()
    await vi.waitFor(() => expect(top.toArray.map((c) => c.id)).toEqual([3, 2]))
    const sub = top.subscribeChanges(() => {}) // a subscriber keeps the window live, like a mounted page

    // a loaded row changed elsewhere: written into the collection, the window follows
    await applyChange({ kind: 'upsert', entity: 'customers', row: { ...rows[1]!, company: 'Renamed', updatedAt: '2026-02-01' } })
    expect(customersCollection.get(2)).toMatchObject({ company: 'Renamed', searchText: expect.stringContaining('renamed') })

    // a row nobody loaded: not stored (it would just accumulate), the windows are re-read instead
    const before = api.customers().length
    rows.push(customer(9))
    await applyChange({ kind: 'upsert', entity: 'customers', row: customer(9) })
    expect(customersCollection.has(9)).toBe(false)
    await vi.waitFor(() => expect(top.toArray.map((c) => c.id)).toEqual([9, 3]))
    expect(api.customers().slice(before)).toContain('/api/customers?status[eq]=active&sort=-mrr,-id&limit=2')
    sub.unsubscribe()
    await top.cleanup()
  })
})

describe('search push-down semantics', () => {
  it("ilike over searchText keeps exactly the server's case-insensitive substring matches, wildcards literal", async () => {
    type Row = { id: number; searchText: string }
    const texts = ['A_B Labs', 'axb labs', 'Owner 50%', 'owner 500', 'Ünïcode GmbH']
    const rows = createCollection(localOnlyCollectionOptions({ id: 'search-semantics', getKey: (r: Row) => r.id }))
    rows.insert(texts.map((t, id) => ({ id, searchText: searchText(t) })))
    const find = async (term: string) => {
      const q = createLiveQueryCollection((b) => b.from({ r: rows }).where(({ r }) => ilike(r.searchText, searchPattern(term))))
      await q.preload()
      const ids = q.toArray.map((r) => texts[r.id])
      await q.cleanup()
      return ids
    }
    // what LIKE '%term%' ESCAPE '\' (wildcards escaped by the server) returns, case-insensitively
    const like = (term: string) => texts.filter((t) => t.toLowerCase().includes(term.toLowerCase()))
    for (const term of ['a_b', 'LABS', '50%', 'owner 5', '_', '%', 'ünï']) expect(await find(term), term).toEqual(like(term))
  })
})

describe('live alerts', () => {
  const v = (status: Customer['status'], mrr: number, updatedAt: string) => ({ id: 1, company: 'Acme', status, mrr, updatedAt })

  it('fires on transitions only: not for rows that load, not twice for an echo, and for created rows', () => {
    const notify = vi.fn()
    const alerts = createCustomerAlerts(notify)
    // first sighting of a row that was not loaded: nothing to compare with
    alerts.landed(v('churned', 0, 't1'), undefined)
    expect(notify).not.toHaveBeenCalled()
    // loaded row (synced) goes active -> churned
    alerts.landed(v('churned', 0, 't3'), v('active', 500, 't2'))
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'churned' }))
    // the same version again (SSE echo of our own write, after the batch response): no second alert
    notify.mockClear()
    alerts.landed(v('churned', 0, 't3'), v('active', 500, 't2'))
    expect(notify).not.toHaveBeenCalled()
    // crossing $20k MRR
    alerts.landed(v('active', 2_500_000, 't4'), v('churned', 0, 't3'))
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'big-account' }))
    // a brand-new churned account (our own create)
    notify.mockClear()
    alerts.landed({ ...v('churned', 0, 't5'), id: 2 }, undefined, { created: true })
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'churned' }))
  })
})
