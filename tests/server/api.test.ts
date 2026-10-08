import { afterAll, describe, expect, it } from 'vite-plus/test'
import type { Customer, CursorPage, Invoice, OverviewMetrics, Page, Task } from '../../shared/domain.ts'
import { testApp } from './helpers.ts'

const { req, dispose } = testApp()
afterAll(dispose)

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

describe('customers API', () => {
  it('paginates', async () => {
    const r = await req<Page<Customer>>('GET', '/customers?page=2&pageSize=10')
    expect(r.status).toBe(200)
    expect(r.body.data).toHaveLength(10)
    expect(r.body).toMatchObject({ total: 120, page: 2, pageSize: 10, pageCount: 12 })
  })

  it('sorts and filters', async () => {
    const r = await req<Page<Customer>>('GET', '/customers?status=active&sort=-mrr&limit=50')
    expect(r.body.data.every((c) => c.status === 'active')).toBe(true)
    const mrrs = r.body.data.map((c) => c.mrr)
    expect(mrrs).toEqual([...mrrs].sort((a, b) => b - a))
  })

  it('searches by text', async () => {
    const all = await req<Page<Customer>>('GET', '/customers?limit=1000')
    const company = all.body.data[0]!.company.split(' ')[0]!
    const r = await req<Page<Customer>>('GET', `/customers?q=${encodeURIComponent(company)}&limit=1000`)
    expect(r.body.total).toBeGreaterThan(0)
    expect(r.body.data.every((c) => `${c.name} ${c.email} ${c.company}`.toLowerCase().includes(company.toLowerCase()))).toBe(true)
  })

  it('returns 400 for invalid queries', async () => {
    expect((await req('GET', '/customers?sort=password')).status).toBe(400)
    expect((await req('GET', '/customers?mrr[gte]=lots')).status).toBe(400)
  })

  it('creates with computed MRR, validates input', async () => {
    const created = await req<Customer>('POST', '/customers', newCustomer)
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ company: 'Testco', mrr: 4900 * 10 })

    const bad = await req<{ error: string; message: string }>('POST', '/customers', { ...newCustomer, email: 'nope', seats: 0 })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('BadRequest')
  })

  it('accepts client-generated ids and rejects duplicates', async () => {
    const id = 900_001
    expect((await req<Customer>('POST', '/customers', { ...newCustomer, id })).body.id).toBe(id)
    expect((await req('POST', '/customers', { ...newCustomer, id })).status).toBe(400)
  })

  it('updates and recomputes MRR', async () => {
    const created = (await req<Customer>('POST', '/customers', newCustomer)).body
    const r = await req<Customer>('PATCH', `/customers/${created.id}`, { plan: 'enterprise', seats: 2 })
    expect(r.body).toMatchObject({ plan: 'enterprise', seats: 2, mrr: 12900 * 2 })
    const churned = await req<Customer>('PATCH', `/customers/${created.id}`, { status: 'churned' })
    expect(churned.body.mrr).toBe(0)
  })

  it('deletes (cascading invoices) and 404s afterwards', async () => {
    const inv = await req<Page<Invoice>>('GET', '/invoices?limit=1')
    const customerId = inv.body.data[0]!.customerId
    expect((await req('DELETE', `/customers/${customerId}`)).status).toBe(204)
    expect((await req('GET', `/customers/${customerId}`)).status).toBe(404)
    expect((await req<Page<Invoice>>('GET', `/invoices?customerId=${customerId}`)).body.total).toBe(0)
    expect((await req('DELETE', `/customers/${customerId}`)).status).toBe(404)
  })

  it('rejects malformed ids', async () => {
    expect((await req('GET', '/customers/abc')).status).toBe(400)
    expect((await req('GET', '/customers/1.5')).status).toBe(400)
  })
})

describe('invoices API', () => {
  it('marks an invoice paid and records an activity event', async () => {
    const open = (await req<Page<Invoice>>('GET', '/invoices?status=open,overdue&limit=1')).body.data[0]!
    const r = await req<Invoice>('PATCH', `/invoices/${open.id}`, { status: 'paid' })
    expect(r.body.status).toBe('paid')
    expect(r.body.paidAt).toBeTruthy()
    const feed = await req<CursorPage<{ type: string; message: string }>>('GET', '/events/feed?limit=1')
    expect(feed.body.data[0]).toMatchObject({ type: 'invoice.paid' })
  })

  it('filters by date range', async () => {
    const r = await req<Page<Invoice>>('GET', '/invoices?issuedAt[gte]=2026-01-01&issuedAt[lte]=2026-01-31T23:59:59Z&limit=1000')
    expect(r.body.data.every((i) => i.issuedAt.startsWith('2026-01'))).toBe(true)
  })
})

describe('tasks API', () => {
  it('supports full CRUD', async () => {
    const created = await req<Task>('POST', '/tasks', {
      projectId: 1,
      title: 'Write tests',
      status: 'todo',
      priority: 'high',
      assigneeId: null,
      dueDate: null,
    })
    expect(created.status).toBe(201)
    const moved = await req<Task>('PATCH', `/tasks/${created.body.id}`, { status: 'done' })
    expect(moved.body.status).toBe('done')
    const list = await req<Page<Task>>('GET', '/tasks?projectId=1&limit=1000')
    expect(list.body.data.some((t) => t.id === created.body.id)).toBe(true)
    expect((await req('DELETE', `/tasks/${created.body.id}`)).status).toBe(204)
    expect((await req('DELETE', `/tasks/${created.body.id}`)).status).toBe(404)
  })

  it('404s when the project does not exist', async () => {
    const r = await req('POST', '/tasks', {
      projectId: 9999,
      title: 'Nope',
      status: 'todo',
      priority: 'low',
      assigneeId: null,
      dueDate: null,
    })
    expect(r.status).toBe(404)
  })
})

describe('events & metrics', () => {
  it('cursor-paginates the activity feed', async () => {
    const p1 = await req<CursorPage<{ id: number }>>('GET', '/events/feed?limit=10')
    expect(p1.body.data).toHaveLength(10)
    const p2 = await req<CursorPage<{ id: number }>>('GET', `/events/feed?limit=10&cursor=${p1.body.nextCursor}`)
    expect(p2.body.data[0]!.id).toBeLessThan(p1.body.data.at(-1)!.id + 1)
    expect(new Set([...p1.body.data, ...p2.body.data].map((e) => e.id)).size).toBe(20)
  })

  it('computes overview metrics consistent with the customer table', async () => {
    const m = (await req<OverviewMetrics>('GET', '/metrics/overview')).body
    const active = (await req<Page<Customer>>('GET', '/customers?status=active&limit=10000')).body.data
    expect(m.activeCustomers).toBe(active.length)
    expect(m.mrr).toBe(active.reduce((s, c) => s + c.mrr, 0))
    expect(m.arr).toBe(m.mrr * 12)
  })

  it('validates metric params', async () => {
    expect((await req('GET', '/metrics/breakdown?by=password')).status).toBe(400)
    expect((await req('GET', '/metrics/revenue?months=999')).status).toBe(400)
    expect((await req<unknown[]>('GET', '/metrics/breakdown?by=plan')).body).toHaveLength(4)
  })
})

describe('chaos mode', () => {
  it('fails writes but not reads when failRate=1', async () => {
    const { req, dispose } = testApp({ failRate: 1 })
    expect((await req('GET', '/customers?limit=1')).status).toBe(200)
    const r = await req<{ error: string }>('PATCH', '/customers/1', { seats: 5 })
    expect(r.status).toBe(503)
    expect(r.body.error).toBe('SimulatedFailure')
    await dispose()
  })

  it('can be reconfigured at runtime', async () => {
    const { req, dispose } = testApp()
    expect((await req('PUT', '/dev/chaos', { latencyMs: 0, failRate: 1 })).status).toBe(200)
    expect((await req('PATCH', '/customers/1', { seats: 5 })).status).toBe(503)
    expect((await req('PUT', '/dev/chaos', { latencyMs: -1, failRate: 0 })).status).toBe(400)
    await dispose()
  })
})
