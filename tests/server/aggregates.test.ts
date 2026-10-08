import { afterAll, describe, expect, it } from 'vite-plus/test'
import type { BreakdownPoint, Customer, Invoice, SummedPage } from '../../shared/domain.ts'
import { parseListParams } from '../../server/db/params.ts'
import { BadQuery, buildOrderBy, buildWhere, type Columns } from '../../server/db/sql.ts'
import { testApp } from './helpers.ts'

const t = testApp()
const { as, db, dispose } = t
afterAll(dispose)
const owner = as('owner')

type Row = Record<string, unknown>
const all = <T = Row>(sql: string, ...params: unknown[]) =>
  db()
    .prepare(sql)
    .all(...params) as T[]

describe('?sum= totals over every matching row', () => {
  it('parses the reserved sum key', () => {
    expect(parseListParams(new URLSearchParams('sum=mrr,seats')).sums).toEqual(['mrr', 'seats'])
    expect(parseListParams(new URLSearchParams('status=active')).sums).toBeUndefined()
    expect(() => parseListParams(new URLSearchParams('sum=mrr);DROP'))).toThrow(BadQuery)
  })

  it('sums over all matches, not just the page, and respects the filters and soft delete', async () => {
    const r = await owner.get<SummedPage<Customer, 'mrr' | 'seats'>>('/customers?status=active&pageSize=5&sum=mrr,seats')
    expect(r.status).toBe(200)
    expect(r.body.data).toHaveLength(5)
    const [expected] = all<{ n: number; mrr: number; seats: number }>(
      `SELECT COUNT(*) AS n, SUM(mrr) AS mrr, SUM(seats) AS seats FROM customers WHERE status = 'active' AND deleted_at IS NULL`,
    )
    expect(r.body.total).toBe(expected!.n)
    expect(r.body.sums).toEqual({ mrr: expected!.mrr, seats: expected!.seats })
    expect(r.body.sums.mrr).toBeGreaterThan(r.body.data.reduce((s, c) => s + c.mrr, 0))
  })

  it('works with limit=0 (totals only) and is 0 for no matches', async () => {
    const none = await owner.get<SummedPage<Customer>>('/customers?q=zzzz-no-match&sum=mrr&limit=0')
    expect(none.body).toMatchObject({ data: [], total: 0, sums: { mrr: 0 } })
    const ids = all<{ id: number; amount: number }>(`SELECT id, amount FROM invoices ORDER BY id LIMIT 3`)
    const inv = await owner.get<SummedPage<Invoice, 'amount'>>(
      `/invoices?id=${ids.map((i) => i.id).join(',')}&sum=amount&limit=0`,
    )
    expect(inv.body.total).toBe(3)
    expect(inv.body.sums.amount).toBe(ids.reduce((s, i) => s + i.amount, 0))
  })

  it('leaves responses without ?sum= unchanged', async () => {
    const r = await owner.get('/customers?pageSize=2')
    expect(Object.keys(r.body).sort()).toEqual(['data', 'page', 'pageCount', 'pageSize', 'total'])
  })

  it('only sums whitelisted numeric fields', async () => {
    expect((await owner.get('/customers?sum=company')).status).toBe(400)
    expect((await owner.get('/customers?sum=id')).status).toBe(400)
    expect((await owner.get('/customers?sum=constructor')).status).toBe(400)
    expect((await owner.get('/users?sum=id')).status).toBe(400)
  })

  it('applies the read scope (archived customers and their invoices drop out of the totals)', async () => {
    const [c] = all<{ id: number; mrr: number }>(
      `SELECT id, mrr FROM customers WHERE status = 'active' AND mrr > 0 AND deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM invoices WHERE customer_id = customers.id) LIMIT 1`,
    )
    const before = await owner.get<SummedPage<Customer, 'mrr'>>('/customers?sum=mrr&limit=0')
    const invBefore = await owner.get<SummedPage<Invoice, 'amount'>>('/invoices?sum=amount&limit=0')
    const [{ amount }] = all<{ amount: number }>(`SELECT SUM(amount) AS amount FROM invoices WHERE customer_id = ?`, c!.id) as [
      { amount: number },
    ]
    expect((await owner.del(`/customers/${c!.id}`)).status).toBe(204)
    const after = await owner.get<SummedPage<Customer, 'mrr'>>('/customers?sum=mrr&limit=0')
    const invAfter = await owner.get<SummedPage<Invoice, 'amount'>>('/invoices?sum=amount&limit=0')
    expect(after.body.total).toBe(before.body.total - 1)
    expect(after.body.sums.mrr).toBeLessThan(before.body.sums.mrr)
    expect(invAfter.body.sums.amount).toBe(invBefore.body.sums.amount - amount)
  })
})

describe('virtual sort / search expressions', () => {
  const cols: Columns = { id: { sql: 'id', type: 'number' }, name: { sql: 'name', type: 'text' } }
  const virtual: Columns = { owner: { sql: '(SELECT u.name FROM users u WHERE u.id = owner_id)', type: 'text' } }

  it('sorts and searches by whitelisted virtual expressions, never filters by them', () => {
    expect(buildOrderBy(cols, [{ field: 'owner', dir: 'desc' }], 'id', virtual)).toBe(
      `ORDER BY ${virtual.owner!.sql} DESC, id ASC`,
    )
    const w = buildWhere(cols, [], { term: 'a%', fields: ['name', 'owner'] }, virtual)
    expect(w.sql).toBe(`WHERE (name LIKE ? ESCAPE '\\' OR ${virtual.owner!.sql} LIKE ? ESCAPE '\\')`)
    expect(w.params).toEqual(['%a\\%%', '%a\\%%'])
    expect(() => buildWhere(cols, [{ field: 'owner', op: 'eq', value: 'x' }], undefined, virtual)).toThrow(BadQuery)
    expect(() => buildOrderBy(cols, [{ field: 'owner', dir: 'asc' }])).toThrow(BadQuery)
  })

  it('sorts customers by owner name', async () => {
    const r = await owner.get<SummedPage<Customer>>('/customers?sort=owner,id&limit=200')
    expect(r.status).toBe(200)
    const names = new Map(all<{ id: number; name: string }>(`SELECT id, name FROM users`).map((u) => [u.id, u.name]))
    const owners = r.body.data.map((c) => (c.ownerId ? names.get(c.ownerId)! : null))
    // SQLite sorts NULLs first ascending
    const sorted = [...owners].sort((a, b) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1))
    expect(owners).toEqual(sorted)
    expect(new Set(owners).size).toBeGreaterThan(1)
    // the row shape is unchanged: no new column
    expect(r.body.data[0]).not.toHaveProperty('owner')
  })

  it('searches customers by owner name too', async () => {
    const [u] = all<{ id: number; name: string }>(
      `SELECT u.id, u.name FROM users u WHERE EXISTS (SELECT 1 FROM customers c WHERE c.owner_id = u.id AND c.deleted_at IS NULL) ORDER BY u.id LIMIT 1`,
    )
    const r = await owner.get<SummedPage<Customer>>(`/customers?q=${encodeURIComponent(u!.name)}&limit=1000&sum=mrr`)
    const owned = all<{ id: number }>(`SELECT id FROM customers WHERE owner_id = ? AND deleted_at IS NULL`, u!.id)
    expect(owned.length).toBeGreaterThan(0)
    const ids = new Set(r.body.data.map((c) => c.id))
    for (const c of owned) expect(ids.has(c.id)).toBe(true)
  })

  it('sorts and searches invoices by customer company', async () => {
    const r = await owner.get<SummedPage<Invoice>>('/invoices?sort=-customer&limit=100')
    expect(r.status).toBe(200)
    const company = new Map(
      all<{ id: number; company: string }>(`SELECT id, company FROM customers`).map((c) => [c.id, c.company]),
    )
    const companies = r.body.data.map((i) => company.get(i.customerId)!)
    expect(companies).toEqual([...companies].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)))

    const [c] = all<{ id: number; company: string }>(
      `SELECT c.id, c.company FROM customers c WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id) AND c.deleted_at IS NULL LIMIT 1`,
    )
    const found = await owner.get<SummedPage<Invoice, 'amount'>>(
      `/invoices?q=${encodeURIComponent(c!.company)}&limit=1000&sum=amount`,
    )
    expect(found.body.data.length).toBeGreaterThan(0)
    expect(found.body.data.some((i) => i.customerId === c!.id)).toBe(true)
    expect(found.body.sums.amount).toBe(found.body.data.reduce((s, i) => s + i.amount, 0))
  })

  it('treats LIKE wildcards in a virtual search literally', async () => {
    const r = await owner.get<SummedPage<Invoice>>('/invoices?q=%25&limit=0')
    expect(r.status).toBe(200)
    expect(r.body.total).toBe(0)
  })

  it('keeps rejecting unknown sort keys', async () => {
    expect((await owner.get('/customers?sort=customer')).status).toBe(400)
    expect((await owner.get('/invoices?sort=owner')).status).toBe(400)
    expect((await owner.get('/customers?owner=Ada')).status).toBe(400)
  })
})

describe('/metrics/breakdown?plan=', () => {
  it('narrows a breakdown to one plan', async () => {
    const r = await owner.get<BreakdownPoint[]>('/metrics/breakdown?by=country&plan=pro')
    expect(r.status).toBe(200)
    const expected = all<{ key: string; customers: number; mrr: number }>(
      `SELECT country AS key, COUNT(*) AS customers, COALESCE(SUM(CASE WHEN status = 'active' THEN mrr END), 0) AS mrr
       FROM customers WHERE deleted_at IS NULL AND plan = 'pro' GROUP BY country`,
    )
    expect([...r.body].sort((a, b) => a.key.localeCompare(b.key))).toEqual(expected.sort((a, b) => a.key.localeCompare(b.key)))
    const unfiltered = await owner.get<BreakdownPoint[]>('/metrics/breakdown?by=country')
    const sum = (ps: BreakdownPoint[]) => ps.reduce((s, p) => s + p.customers, 0)
    expect(sum(r.body)).toBeLessThan(sum(unfiltered.body))
  })

  it('filters status breakdowns too, and validates the plan', async () => {
    const r = await owner.get<BreakdownPoint[]>('/metrics/breakdown?by=status&plan=free')
    const [n] = all<{ n: number }>(`SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL AND plan = 'free'`)
    expect(r.body.reduce((s, p) => s + p.customers, 0)).toBe(n!.n)
    expect((await owner.get('/metrics/breakdown?by=status&plan=platinum')).status).toBe(400)
    expect((await owner.get("/metrics/breakdown?by=status&plan=pro'--")).status).toBe(400)
    expect((await owner.get('/metrics/breakdown?by=status&plan=')).status).toBe(200)
  })
})
