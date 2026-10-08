import { afterAll, describe, expect, it } from 'vite-plus/test'
import type { Customer, Invoice, Page } from '../../shared/domain.ts'
import { testApp } from './helpers.ts'

// Scale work (pnpm db:big): index-backed search, the revenue rollup and the
// archived-customer scope must answer exactly what the slow versions did.
const t = testApp()
const { as, db, dispose } = t
afterAll(dispose)
const owner = as('owner')

const all = <T = Record<string, unknown>>(sql: string, ...params: unknown[]) =>
  db()
    .prepare(sql)
    .all(...params) as T[]
const ids = (p: { body: Page<{ id: number }> }) => p.body.data.map((r) => r.id).sort((a, b) => a - b)
const like = (term: string) => `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`

describe('trigram full-text search', () => {
  /** what the LIKE search returned before the index (name/email/company/owner name) */
  const customersByLike = (term: string) =>
    all<{ id: number }>(
      `SELECT c.id FROM customers c LEFT JOIN users u ON u.id = c.owner_id
       WHERE c.deleted_at IS NULL AND (c.name LIKE @t ESCAPE '\\' OR c.email LIKE @t ESCAPE '\\' OR c.company LIKE @t ESCAPE '\\' OR u.name LIKE @t ESCAPE '\\')
       ORDER BY c.id`,
      { t: like(term) },
    ).map((r) => r.id)

  it.each(['labs', 'LABS', 'acme', 'son', 'a.', '@', 'zz', 'x', '%', '_', 'no such thing'])(
    'customers ?q=%s matches exactly what the LIKE search did',
    async (term) => {
      const res = await owner.get<Page<Customer>>(`/customers?q=${encodeURIComponent(term)}&limit=10000`)
      expect(res.status).toBe(200)
      expect(ids(res)).toEqual(customersByLike(term))
    },
  )

  it('invoices ?q= matches the number or the customer company', async () => {
    const term = 'labs'
    const expected = all<{ id: number }>(
      `SELECT i.id FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE c.deleted_at IS NULL AND (i.number LIKE @t ESCAPE '\\' OR c.company LIKE @t ESCAPE '\\') ORDER BY i.id`,
      { t: like(term) },
    ).map((r) => r.id)
    expect(expected.length).toBeGreaterThan(0)
    const res = await owner.get<Page<Invoice>>(`/invoices?q=${term}&limit=10000`)
    expect(ids(res)).toEqual(expected)
  })

  it('follows inserts and renames (the index is kept in sync by triggers)', async () => {
    const created = await owner.post<Customer>('/customers', {
      name: 'Quentin Quuxley',
      email: 'q@quux.io',
      company: 'Quuxworks',
      plan: 'starter',
      status: 'active',
      country: 'US',
      seats: 2,
      ownerId: 1,
    })
    expect(created.status).toBe(201)
    const find = async (q: string) => ids(await owner.get(`/customers?q=${q}&limit=100`))
    expect(await find('quuxworks')).toEqual([created.body.id])
    await owner.patch(`/customers/${created.body.id}`, { company: 'Zorblat Inc' })
    expect(await find('quuxworks')).toEqual([])
    expect(await find('zorblat')).toEqual([created.body.id])
  })
})

describe('revenue rollup', () => {
  const fromLedger = () =>
    all<{ month: string; revenue: number; invoices: number }>(
      `SELECT substr(received_at, 1, 7) AS month, SUM(amount) AS revenue, COUNT(DISTINCT invoice_id) AS invoices
       FROM payments GROUP BY month ORDER BY month`,
    )
  const rollup = () => all(`SELECT month, revenue, invoices FROM revenue_monthly ORDER BY month`)

  it('equals a GROUP BY over the payments ledger, also after partial payments', async () => {
    expect(rollup()).toEqual(fromLedger())
    const open = all<{ id: number; amount: number }>(
      `SELECT id, amount FROM invoices WHERE status = 'open' AND amount > 300 LIMIT 1`,
    )[0]!
    // two instalments on the same invoice in the same month count that invoice once
    expect((await owner.post('/payments', { invoiceId: open.id, amount: 100, method: 'card' })).status).toBe(201)
    expect((await owner.post('/payments', { invoiceId: open.id, amount: 100, method: 'card' })).status).toBe(201)
    expect(rollup()).toEqual(fromLedger())
  })
})

describe('archived-customer scope (NOT IN the small archived set)', () => {
  it('hides every child row of an archived customer, and only those', async () => {
    const victim = all<{ id: number }>(
      `SELECT c.id FROM customers c WHERE c.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM payments p WHERE p.customer_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status IN ('open', 'overdue')
                         AND EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id))
       LIMIT 1`,
    )[0]!
    const count = async (path: string) => (await owner.get<Page<unknown>>(`${path}&limit=0`)).body.total
    const before = await count(`/payments?customerId[eq]=${victim.id}`)
    expect(before).toBeGreaterThan(0)
    const totalBefore = await count('/payments?')
    expect((await owner.del(`/customers/${victim.id}`)).status).toBe(204)
    expect(await count(`/payments?customerId[eq]=${victim.id}`)).toBe(0)
    expect(await count('/payments?')).toBe(totalBefore - before)
  })
})

describe('product adoption (server aggregate)', () => {
  it('equals a GROUP BY over live subscriptions of live customers', async () => {
    const expected = all(
      `SELECT s.product_id AS productId, COUNT(*) AS subscriptions, SUM(s.quantity) AS units, SUM(s.quantity * s.unit_price) AS mrr
       FROM subscriptions s JOIN customers c ON c.id = s.customer_id
       WHERE s.status IN ('active', 'past_due') AND c.deleted_at IS NULL GROUP BY s.product_id ORDER BY s.product_id`,
    )
    const res = await owner.get('/metrics/product-adoption')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(expected)
    expect((await as('anon').get('/metrics/product-adoption')).status).toBe(401)
  })

  it('invoices carry their customer company', async () => {
    const page = await owner.get<Page<Invoice>>('/invoices?limit=5')
    for (const i of page.body.data) {
      const [c] = all<{ company: string }>('SELECT company FROM customers WHERE id = ?', i.customerId)
      expect(i.customerCompany).toBe(c!.company)
    }
  })
})
