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
