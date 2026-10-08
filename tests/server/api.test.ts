import { afterAll, describe, expect, it } from 'vite-plus/test'
import type { Customer, Invoice, Page, Payment, Subscription, Task } from '../../shared/domain.ts'
import { testApp } from './helpers.ts'

const t = testApp()
const { req, as, dispose } = t
afterAll(dispose)
const owner = as('owner')

const newCustomer = {
  name: 'Test Person',
  email: 'test@example.com',
  company: 'Testco',
  plan: 'pro',
  status: 'active',
  country: 'US',
  seats: 10,
  ownerId: 1,
}

describe('authentication', () => {
  it('rejects anonymous requests and bad credentials', async () => {
    expect((await as('anon').get('/customers')).status).toBe(401)
    const bad = await req('POST', '/auth/login', { email: 'owner@saasly.dev', password: 'nope' }, 'anon')
    expect(bad.status).toBe(401)
  })
  it('returns the caller with role permissions and teams', async () => {
    const me = await as('member').get('/auth/me')
    expect(me.body.user.email).toBe('member@saasly.dev')
    expect(me.body.permissions).toContain('customers:write')
    expect(me.body.permissions).not.toContain('billing:write')
    expect(me.body.teamIds).toContain(1)
  })
  it('lists demo accounts publicly for the login screen', async () => {
    const r = await as('anon').get('/auth/demo-users')
    expect(r.body.map((u: { role: string }) => u.role)).toEqual(['owner', 'admin', 'billing', 'member', 'viewer'])
  })
})

describe('generic resources', () => {
  it('exposes every table through the same list grammar', async () => {
    const all = await owner.get<Array<{ name: string; mode: string }>>('/resources')
    expect(all.body.length).toBeGreaterThanOrEqual(25)
    for (const r of all.body) {
      const res = await owner.get(`/${r.name}?limit=2`)
      expect(res.status, r.name).toBe(200)
      expect(res.body.data.length, r.name).toBeLessThanOrEqual(2)
    }
  })
  it('paginates, sorts, filters and searches', async () => {
    const p = await owner.get<Page<Customer>>('/customers?page=2&pageSize=10&status=active&sort=-mrr')
    expect(p.body.data).toHaveLength(10)
    expect(p.body.data.every((c) => c.status === 'active')).toBe(true)
    const mrrs = p.body.data.map((c) => c.mrr)
    expect(mrrs).toEqual([...mrrs].sort((a, b) => b - a))
    expect((await owner.get('/customers?sort=password')).status).toBe(400)
    expect((await owner.get('/customers?mrr[gte]=lots')).status).toBe(400)
  })
  it('404s unknown resources and ids', async () => {
    expect((await owner.get('/nope')).status).toBe(404)
    expect((await owner.get('/customers/999999')).status).toBe(404)
  })
})

describe('authorization (RBAC + row-level)', () => {
  it('viewer is read-only', async () => {
    const viewer = as('viewer')
    expect((await viewer.get('/customers?limit=1')).status).toBe(200)
    expect((await viewer.patch('/customers/1', { seats: 2 })).status).toBe(403)
    expect((await viewer.post('/task-comments', { taskId: 1, body: 'hi' })).status).toBe(403)
    expect((await viewer.get('/audit-log')).status).toBe(403)
  })
  it('members may only edit customers they own', async () => {
    const member = as('member')
    const mine = (await member.get<Page<Customer>>('/customers?ownerId=4&limit=1')).body.data[0]!
    const theirs = (await member.get<Page<Customer>>('/customers?ownerId[neq]=4&limit=1')).body.data[0]!
    expect((await member.patch(`/customers/${mine.id}`, { country: 'DE' })).status).toBe(200)
    const denied = await member.patch(`/customers/${theirs.id}`, { country: 'DE' })
    expect(denied.status).toBe(403)
    expect(denied.body.message).toMatch(/own/)
    // ...and cannot hand their account to someone else
    expect((await member.patch(`/customers/${mine.id}`, { ownerId: 2 })).status).toBe(403)
  })
  it('members creating customers become the owner', async () => {
    const r = await as('member').post<Customer>('/customers', { ...newCustomer, ownerId: 1 })
    expect(r.status).toBe(201)
    expect(r.body.ownerId).toBe(4)
  })
  it('billing can record payments, members cannot', async () => {
    const inv = (await owner.get<Page<Invoice>>('/invoices?status=open,overdue&limit=1')).body.data[0]!
    expect((await as('member').post(`/invoices/${inv.id}/pay`)).status).toBe(403)
    expect((await as('billing').post(`/invoices/${inv.id}/pay`)).status).toBe(201)
  })
  it('scopes notifications and sessions to their owner', async () => {
    const mine = await as('member').get<Page<{ userId: number }>>('/notifications?limit=100')
    expect(mine.body.data.every((n) => n.userId === 4)).toBe(true)
    const someoneElses = (await owner.get<Page<{ id: number }>>('/notifications?limit=1')).body.data[0]!
    expect((await as('member').patch(`/notifications/${someoneElses.id}`, { readAt: null })).status).toBe(404)
  })
  it('writes denied attempts to the audit log', async () => {
    await as('viewer').patch('/customers/2', { seats: 3 })
    const log = await owner.get('/audit-log?action=denied&sort=-id&limit=1')
    expect(log.body.data[0]).toMatchObject({ action: 'denied', actorId: 5 })
  })
  it('protects role changes', async () => {
    expect((await owner.patch('/users/1', { role: 'viewer' })).status).toBe(403) // own role
    expect((await as('member').patch('/users/6', { role: 'admin' })).status).toBe(403)
  })
})

describe('business rules', () => {
  it('derives MRR from subscriptions when plan/seats/status change', async () => {
    const c = (await owner.post<Customer>('/customers', newCustomer)).body
    expect(c.mrr).toBe(4900 * 10)
    const subs = (await owner.get<Page<Subscription>>(`/subscriptions?customerId=${c.id}`)).body.data
    expect(subs).toHaveLength(1)
    const up = (await owner.patch<Customer>(`/customers/${c.id}`, { plan: 'enterprise', seats: 2 })).body
    expect(up.mrr).toBe(12900 * 2)
    const history = (await owner.get<Page<Subscription>>(`/subscriptions?customerId=${c.id}&sort=id`)).body.data
    expect(history.map((s) => s.status)).toEqual(['canceled', 'active']) // plan change = new subscription
    const churned = (await owner.patch<Customer>(`/customers/${c.id}`, { status: 'churned' })).body
    expect(churned.mrr).toBe(0)
  })
  it('add-on subscriptions add to MRR; base plans are changed via the customer', async () => {
    const c = (await owner.post<Customer>('/customers', newCustomer)).body
    const addon = await as('billing').post<Subscription>('/subscriptions', { customerId: c.id, productId: 5, quantity: 10 })
    expect(addon.status).toBe(201)
    expect((await owner.get<Customer>(`/customers/${c.id}`)).body.mrr).toBe(4900 * 10 + 400 * 10)
    expect((await as('billing').post('/subscriptions', { customerId: c.id, productId: 4, quantity: 1 })).status).toBe(409)
  })
  it('payments are an append-only ledger that settles invoices and rolls up balances', async () => {
    const inv = (await owner.get<Page<Invoice>>('/invoices?status=open,overdue&limit=1&sort=-amount')).body.data[0]!
    const before = (await owner.get(`/customer-balances/${inv.customerId}`)).body
    const part = await owner.post<Payment>('/payments', { invoiceId: inv.id, method: 'wire', amount: 100 })
    expect(part.status).toBe(201)
    expect((await owner.get<Invoice>(`/invoices/${inv.id}`)).body.status).toBe(inv.status) // not yet covered
    expect((await owner.post('/payments', { invoiceId: inv.id, method: 'wire', amount: inv.amount })).status).toBe(400) // overpayment
    await owner.post(`/invoices/${inv.id}/pay`, { method: 'ach' })
    expect((await owner.get<Invoice>(`/invoices/${inv.id}`)).body.status).toBe('paid')
    const after = (await owner.get(`/customer-balances/${inv.customerId}`)).body
    expect(after.paid - before.paid).toBe(inv.amount)
    expect(after.outstanding).toBe(before.outstanding - inv.amount)
    expect((await owner.patch(`/payments/${part.body.id}`, { amount: 1 })).status).toBe(405)
    expect((await owner.del(`/payments/${part.body.id}`)).status).toBe(405)
    expect((await owner.post(`/invoices/${inv.id}/pay`)).status).toBe(409) // already paid
  })
  it('invoices can only be voided, never manually moved to other states', async () => {
    const inv = (await owner.get<Page<Invoice>>('/invoices?status=open,overdue&limit=1')).body.data[0]!
    expect((await owner.patch(`/invoices/${inv.id}`, { status: 'overdue' })).status).toBe(409)
    expect((await owner.patch<Invoice>(`/invoices/${inv.id}`, { status: 'void' })).body.status).toBe('void')
    expect((await owner.post(`/invoices/${inv.id}/pay`)).status).toBe(409)
    const paid = (await owner.get<Page<Invoice>>('/invoices?status=paid&limit=1')).body.data[0]!
    expect((await owner.patch(`/invoices/${paid.id}`, { status: 'void' })).status).toBe(409)
  })
  it('archiving a customer soft-deletes it, cancels billing and keeps history', async () => {
    const inv = (await owner.get<Page<Invoice>>('/invoices?status=paid&limit=1')).body.data[0]!
    const payments = (await owner.get<Page<Payment>>(`/payments?customerId=${inv.customerId}`)).body.total
    expect(payments).toBeGreaterThan(0)
    expect((await owner.del(`/customers/${inv.customerId}`)).status).toBe(204)
    expect((await owner.get(`/customers/${inv.customerId}`)).status).toBe(404)
    // the archived account's rows are no longer served by any child resource...
    for (const r of ['payments', 'subscriptions', 'contacts', 'customer-tags', 'usage-events', 'usage-daily', 'invoices'])
      expect((await owner.get<Page<unknown>>(`/${r}?customerId=${inv.customerId}`)).body.total, r).toBe(0)
    expect((await owner.get(`/customer-balances/${inv.customerId}`)).status).toBe(404)
    // ...but the history is kept, and billing was canceled
    const db = t.db()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE customer_id = ?`).get(inv.customerId)).toEqual({ n: payments })
    const subs = db.prepare(`SELECT status FROM subscriptions WHERE customer_id = ?`).all(inv.customerId) as Array<{
      status: string
    }>
    expect(subs.length).toBeGreaterThan(0)
    expect(subs.every((s) => s.status === 'canceled')).toBe(true)
  })
  it('task comments are permanent: tasks with comments cannot be deleted', async () => {
    const t = (
      await owner.post<Task>('/tasks', {
        projectId: 1,
        title: 'Temp task',
        status: 'todo',
        priority: 'low',
        assigneeId: 4,
        dueDate: null,
      })
    ).body
    await owner.post('/task-comments', { taskId: t.id, body: 'keep me' })
    expect((await owner.del(`/tasks/${t.id}`)).status).toBe(409)
    const c = (await owner.get(`/task-comments?taskId=${t.id}`)).body.data[0]
    expect((await owner.patch(`/task-comments/${c.id}`, { body: 'edited' })).status).toBe(405)
    // the assignee was notified about the assignment and the comment
    const notes = (await as('member').get('/notifications?entity=tasks&sort=-id&limit=2')).body.data
    expect(notes.map((n: { kind: string }) => n.kind).sort()).toEqual(['assignment', 'mention'])
  })
  it('time entries belong to their author', async () => {
    const e = await as('member').post('/time-entries', {
      taskId: 1,
      minutes: 45,
      spentOn: '2026-06-01',
      billable: true,
      note: '',
    })
    expect(e.body.userId).toBe(4)
    expect((await as('admin').patch(`/time-entries/${e.body.id}`, { minutes: 50 })).status).toBe(200)
    const others = (await owner.get('/time-entries?userId[neq]=4&limit=1')).body.data[0]
    expect((await as('member').patch(`/time-entries/${others.id}`, { minutes: 5 })).status).toBe(403)
    expect(
      (await as('member').post('/time-entries', { taskId: 1, minutes: 2000, spentOn: '2026-06-01', billable: true, note: '' }))
        .status,
    ).toBe(400)
  })
  it('usage ingestion is idempotent and rolls up per day', async () => {
    const ev = { customerId: 3, metric: 'api_calls', quantity: 11, occurredAt: '2026-06-15T08:00:00Z', idempotencyKey: 'abc' }
    const before = (await owner.get('/usage-daily/3:api_calls:2026-06-15')).body?.quantity ?? 0
    const a = await owner.post('/usage-events', ev)
    const b = await owner.post('/usage-events', ev)
    expect(a.body.id).toBe(b.body.id)
    expect((await owner.get('/usage-daily/3:api_calls:2026-06-15')).body.quantity).toBe(before + 11)
    expect((await owner.del(`/usage-events/${a.body.id}`)).status).toBe(405)
  })
  it('records an audit trail with field-level diffs', async () => {
    await owner.patch('/projects/2', { budgetHours: 123 })
    const log = (await owner.get('/audit-log?entity=projects&entityId=2&sort=-id&limit=1')).body.data[0]
    expect(log.action).toBe('update')
    expect(JSON.parse(log.changes).budgetHours[1]).toBe(123)
  })
})

describe('batch', () => {
  it('commits multi-entity ops atomically', async () => {
    const r = await owner.post('/batch', {
      ops: [
        { entity: 'tags', op: 'insert', data: { name: 'batch-tag', color: '#112233' } },
        { entity: 'customer-tags', op: 'insert', data: { customerId: 5, tagId: 9 } },
        { entity: 'tasks', op: 'update', id: 1, data: { priority: 'urgent' } },
      ],
    })
    expect(r.status).toBe(200)
    expect(r.body.results.map((x: { entity: string }) => x.entity)).toEqual(['tags', 'customer-tags', 'tasks'])
  })
  it('rolls everything back when any op fails (incl. authorization)', async () => {
    const r = await as('member').post('/batch', {
      ops: [
        { entity: 'task-comments', op: 'insert', data: { taskId: 2, body: 'should vanish' } },
        { entity: 'payments', op: 'insert', data: { invoiceId: 1, method: 'card' } },
      ],
    })
    expect(r.status).toBe(403)
    expect((await owner.get('/task-comments?body=should vanish')).body.total).toBe(0)
  })
})

describe('rollup jobs & metrics', () => {
  it('rebuilds MRR snapshots and computes AR aging', async () => {
    expect((await as('member').post('/jobs/rebuild-mrr')).status).toBe(403)
    expect((await as('billing').post('/jobs/rebuild-mrr')).body.months).toBe(18)
    const aging = (await as('billing').get('/metrics/ar-aging')).body
    expect(aging.length).toBeGreaterThan(0)
  })
  it('overview MRR equals the sum of active customer MRR', async () => {
    const m = (await owner.get('/metrics/overview')).body
    const active = (await owner.get<Page<Customer>>('/customers?status=active&limit=10000')).body.data
    expect(m.mrr).toBe(active.reduce((s, c) => s + c.mrr, 0))
  })
})

describe('chaos mode', () => {
  it('fails writes but not reads when failRate=1', async () => {
    const { as, dispose } = testApp({ failRate: 1 })
    expect((await as('owner').get('/customers?limit=1')).status).toBe(200)
    expect((await as('owner').patch('/customers/1', { seats: 5 })).status).toBe(503)
    await dispose()
  })
})
