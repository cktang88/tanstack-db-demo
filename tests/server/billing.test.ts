import { afterAll, describe, expect, it } from 'vite-plus/test'
import type { Customer, Invoice, Page } from '../../shared/domain.ts'
import { testApp } from './helpers.ts'

const t = testApp()
afterAll(t.dispose)
const owner = t.as('owner')
const billing = t.as('billing')

const openInvoice = async (offset = 0) =>
  (await owner.get<Page<Invoice>>(`/invoices?status=open,overdue&sort=-amount&limit=1&offset=${offset}`)).body.data[0]!
const balance = async (customerId: number) => (await owner.get(`/customer-balances/${customerId}`)).body
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)

describe('customer balances', () => {
  it('count partial payments against outstanding and overdue', async () => {
    const inv = await openInvoice()
    const before = await balance(inv.customerId)
    expect((await billing.post('/payments', { invoiceId: inv.id, method: 'wire', amount: 100 })).status).toBe(201)
    const after = await balance(inv.customerId)
    expect(after.paid - before.paid).toBe(100)
    expect(after.outstanding).toBe(before.outstanding - 100)
    if (inv.status === 'overdue') expect(after.overdue).toBe(before.overdue - 100)
  })
  it('agree with AR aging on the dashboard', async () => {
    const overview = (await owner.get('/metrics/overview')).body
    const aging: Array<{ amount: number }> = (await billing.get('/metrics/ar-aging')).body
    expect(overview.outstanding).toBe(aging.reduce((s, b) => s + b.amount, 0))
  })
})

describe('invoices', () => {
  it('cannot be voided once partially paid', async () => {
    const inv = await openInvoice(1)
    await billing.post('/payments', { invoiceId: inv.id, method: 'card', amount: 50 })
    const r = await owner.patch(`/invoices/${inv.id}`, { status: 'void' })
    expect(r.status).toBe(409)
    expect((await owner.get<Invoice>(`/invoices/${inv.id}`)).body.status).toBe(inv.status)
  })
  it('follow their due date between open and overdue', async () => {
    const inv = await openInvoice(2)
    const today = await owner.patch<Invoice>(`/invoices/${inv.id}`, { dueAt: isoDay(0) })
    expect(today.body.status).toBe('open') // due today = not overdue yet
    expect(today.body.dueAt).toBe(`${isoDay(0)}T23:59:59.999Z`)
    expect((await owner.patch<Invoice>(`/invoices/${inv.id}`, { dueAt: isoDay(-3) })).body.status).toBe('overdue')
    expect((await owner.patch<Invoice>(`/invoices/${inv.id}`, { dueAt: `${isoDay(10)}T09:00:00+02:00` })).body).toMatchObject({
      status: 'open',
      dueAt: `${isoDay(10)}T07:00:00.000Z`,
    })
  })
  it('reject malformed dates', async () => {
    const inv = await openInvoice(3)
    for (const dueAt of ['2026-02-30', '2026-06-15garbage', '2026-06-15T10:00', '2026-13-01', 'tomorrow'])
      expect((await owner.patch(`/invoices/${inv.id}`, { dueAt })).status, dueAt).toBe(400)
  })
})

describe('mark-overdue job', () => {
  it('publishes every invoice it ages', async () => {
    const s = await t.openStream(await t.login('billing'))
    try {
      const r = await billing.post<{ changed: number }>('/jobs/mark-overdue')
      expect(r.status).toBe(200)
      expect(r.body.changed).toBeGreaterThan(0) // the seed's "now" is in the past
      await s.until(
        () => s.changes().filter((m) => m.entity === 'invoices' && m.row?.status === 'overdue').length === r.body.changed,
      )
      expect(s.changes().some((m) => m.entity === 'customer-balances')).toBe(true)
    } finally {
      await s.cancel()
    }
  })
})

describe('archiving customers', () => {
  const customerWith = async (where: string) => {
    const db = t.db()
    return (
      db.prepare(`SELECT c.id FROM customers c WHERE c.deleted_at IS NULL AND ${where} ORDER BY c.id LIMIT 1`).get() as {
        id: number
      }
    ).id
  }
  it('voids unpaid open invoices so nothing is stranded', async () => {
    const id = await customerWith(
      `EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status IN ('open', 'overdue'))
       AND NOT EXISTS (SELECT 1 FROM invoices i JOIN payments p ON p.invoice_id = i.id WHERE i.customer_id = c.id AND i.status IN ('open', 'overdue'))`,
    )
    expect((await owner.del(`/customers/${id}`)).status).toBe(204)
    const left = t
      .db()
      .prepare(`SELECT COUNT(*) AS n FROM invoices WHERE customer_id = ? AND status IN ('open', 'overdue')`)
      .get(id)
    expect(left).toEqual({ n: 0 })
    expect(t.db().prepare(`SELECT outstanding FROM customer_balances WHERE customer_id = ?`).get(id)).toEqual({ outstanding: 0 })
  })
  it('refuses while a partially paid invoice is open', async () => {
    const inv = await openInvoice(4)
    await billing.post('/payments', { invoiceId: inv.id, method: 'card', amount: 10 })
    const r = await owner.del(`/customers/${inv.customerId}`)
    expect(r.status).toBe(409)
    expect((await owner.get<Customer>(`/customers/${inv.customerId}`)).status).toBe(200)
  })
})

const newCustomer = {
  name: 'Mrr Person',
  email: 'mrr@example.com',
  company: 'Mrrco',
  plan: 'pro',
  status: 'active',
  country: 'US',
  seats: 10,
  ownerId: 1,
}
type Movement = { customerId: number; kind: string; oldMrr: number; newMrr: number; delta: number; month: string }
const movements = async (customerId: number) =>
  (await billing.get<Page<Movement>>(`/mrr-movements?customerId=${customerId}&sort=id`)).body.data

describe('MRR movements ledger', () => {
  it('records one net movement per customer change (no churn + new for a plan change)', async () => {
    const c = (await owner.post<Customer>('/customers', newCustomer)).body
    await owner.patch(`/customers/${c.id}`, { plan: 'enterprise', seats: 2 }) // 49000 -> 25800
    await owner.patch(`/customers/${c.id}`, { seats: 4 }) // -> 51600
    await owner.patch(`/customers/${c.id}`, { status: 'churned' })
    await owner.patch(`/customers/${c.id}`, { status: 'active' })
    expect((await movements(c.id)).map((m) => [m.kind, m.delta])).toEqual([
      ['new', 49000],
      ['contraction', 25800 - 49000],
      ['expansion', 51600 - 25800],
      ['churn', -51600],
      ['reactivation', 51600],
    ])
  })
  it('counts trials from conversion and add-ons as expansion', async () => {
    const c = (await owner.post<Customer>('/customers', { ...newCustomer, status: 'trial' })).body
    expect(c.mrr).toBe(0)
    expect(await movements(c.id)).toEqual([])
    const addon = await billing.post('/subscriptions', { customerId: c.id, productId: 5, quantity: 10 })
    expect(addon.body.status).toBe('trialing') // add-ons follow the account
    expect(await movements(c.id)).toEqual([])
    await owner.patch(`/customers/${c.id}`, { status: 'active' })
    await billing.post('/subscriptions', { customerId: c.id, productId: 8, quantity: 1 })
    expect((await movements(c.id)).map((m) => [m.kind, m.delta])).toEqual([
      ['new', 49000 + 4000],
      ['expansion', 2500],
    ])
  })
  it('is append-only', async () => {
    const m = (await billing.get<Page<{ id: number }>>('/mrr-movements?limit=1')).body.data[0]!
    expect((await owner.post('/mrr-movements', { customerId: 1 })).status).toBe(405)
    expect((await owner.patch(`/mrr-movements/${m.id}`, { delta: 1 })).status).toBe(405)
    expect(() => t.db().prepare(`DELETE FROM mrr_movements WHERE id = ?`).run(m.id)).toThrow(/append-only/)
  })
  it('snapshots derive from the ledger: later seat changes do not rewrite history', async () => {
    await billing.post('/jobs/rebuild-mrr')
    const snaps = async () =>
      (await billing.get<Page<{ month: string; mrr: number }>>('/mrr-snapshots?sort=month&limit=100')).body.data
    const before = await snaps()
    const c = (await owner.get<Page<Customer>>('/customers?status=active&plan=pro&sort=id&limit=1')).body.data[0]!
    await owner.patch(`/customers/${c.id}`, { seats: c.seats + 5 })
    await billing.post('/jobs/rebuild-mrr')
    const after = await snaps()
    expect(after.slice(0, -1).map((s) => s.mrr)).toEqual(before.slice(0, -1).map((s) => s.mrr))
    const current = after.at(-1)!
    const total = (t.db().prepare(`SELECT SUM(mrr) AS s FROM customers`).get() as { s: number }).s
    expect(current.mrr).toBe(total)
  })
})

describe('subscriptions vs the customer projection', () => {
  it('base-plan status changes go through the customer', async () => {
    const c = (await owner.post<Customer>('/customers', newCustomer)).body
    const base = (await billing.get<Page<{ id: number }>>(`/subscriptions?customerId=${c.id}`)).body.data[0]!
    expect((await billing.patch(`/subscriptions/${base.id}`, { status: 'canceled' })).status).toBe(409)
    expect((await billing.patch(`/subscriptions/${base.id}`, { quantity: 12 })).status).toBe(200)
    expect((await owner.get<Customer>(`/customers/${c.id}`)).body).toMatchObject({ seats: 12, mrr: 12 * 4900, status: 'active' })
  })
  it('churned customers cannot take add-ons', async () => {
    const c = (await owner.post<Customer>('/customers', { ...newCustomer, status: 'churned' })).body
    expect((await billing.post('/subscriptions', { customerId: c.id, productId: 5, quantity: 1 })).status).toBe(409)
  })
  it('plan prices come from the product catalog', async () => {
    const pro = (await owner.get<{ unitPrice: number }>('/products/3')).body
    expect((await owner.patch('/products/3', { unitPrice: 5100 })).status).toBe(200)
    try {
      const c = (await owner.post<Customer>('/customers', { ...newCustomer, seats: 3 })).body
      expect(c.mrr).toBe(3 * 5100)
    } finally {
      await owner.patch('/products/3', { unitPrice: pro.unitPrice })
    }
  })
})
