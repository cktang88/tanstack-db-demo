import { afterAll, describe, expect, it } from 'vite-plus/test'
import type { Customer, Page } from '../../shared/domain.ts'
import { testApp } from './helpers.ts'

const t = testApp()
afterAll(t.dispose)
const owner = t.as('owner')

describe('change publishing', () => {
  it('touches every rollup a write affects', async () => {
    const s = await t.openStream(await t.login('owner'))
    try {
      const seen = (entity: string, id: number) => () =>
        s.changes().some((m) => m.entity === entity && (m.row?.id ?? m.id) === id)
      // creating a task / moving it between projects updates both projects' stats
      const task = (
        await owner.post('/tasks', {
          projectId: 1,
          title: 'Publish me',
          status: 'todo',
          priority: 'low',
          assigneeId: null,
          dueDate: null,
        })
      ).body
      await s.until(seen('project-stats', 1))
      const entry = (
        await owner.post('/time-entries', { taskId: task.id, minutes: 30, spentOn: '2026-06-01', billable: true, note: '' })
      ).body
      expect((await owner.patch(`/tasks/${task.id}`, { projectId: 2 })).status).toBe(200)
      await s.until(seen('project-stats', 2))
      const before = s.changes().length
      // deleting a time entry updates its project's stats
      expect((await owner.del(`/time-entries/${entry.id}`)).status).toBe(204)
      await s.until(() =>
        s
          .changes()
          .slice(before)
          .some((m) => m.entity === 'project-stats' && m.row?.id === 2),
      )
      // customer and usage writes update the health view
      const c = (await owner.get<Page<Customer>>('/customers?status=active&limit=1')).body.data[0]!
      await owner.patch(`/customers/${c.id}`, { seats: c.seats + 1 })
      await s.until(seen('customer-health', c.id))
    } finally {
      await s.cancel()
    }
  })
})

describe('usage ingestion', () => {
  const ev = (over: Record<string, unknown> = {}) => ({
    customerId: 3,
    metric: 'api_calls',
    quantity: 5,
    occurredAt: '2026-06-15T23:30:00-05:00',
    ...over,
  })
  it('buckets by the UTC day', async () => {
    const before = (await owner.get('/usage-daily/3:api_calls:2026-06-16')).body?.quantity ?? 0
    const r = await owner.post('/usage-events', ev())
    expect(r.status).toBe(201)
    expect(r.body.occurredAt).toBe('2026-06-16T04:30:00.000Z')
    expect((await owner.get('/usage-daily/3:api_calls:2026-06-16')).body.quantity).toBe(before + 5)
  })
  it('scopes idempotency keys per customer and rejects conflicting replays', async () => {
    const a = await owner.post('/usage-events', ev({ idempotencyKey: 'shared-key' }))
    const b = await owner.post('/usage-events', ev({ idempotencyKey: 'shared-key', customerId: 4 }))
    expect(b.status).toBe(201)
    expect(b.body.id).not.toBe(a.body.id)
    expect((await owner.post('/usage-events', ev({ idempotencyKey: 'shared-key' }))).body.id).toBe(a.body.id)
    // same instant written with another offset is the same event
    expect(
      (await owner.post('/usage-events', ev({ idempotencyKey: 'shared-key', occurredAt: '2026-06-16T04:30:00Z' }))).body.id,
    ).toBe(a.body.id)
    const clash = await owner.post('/usage-events', ev({ idempotencyKey: 'shared-key', quantity: 6 }))
    expect(clash.status).toBe(409)
  })
  it('rejects usage for archived customers', async () => {
    const c = (
      await owner.post<Customer>('/customers', {
        name: 'Gone Soon',
        email: 'gone@example.com',
        company: 'Goneco',
        plan: 'starter',
        status: 'active',
        country: 'US',
        seats: 1,
        ownerId: 1,
      })
    ).body
    expect((await owner.del(`/customers/${c.id}`)).status).toBe(204)
    expect((await owner.post('/usage-events', ev({ customerId: c.id }))).status).toBe(409)
  })
})

describe('activity feed', () => {
  type Ev = { id: number; type: string }
  const feed = async (q: string) => (await owner.get<{ data: Ev[]; nextCursor: number | null }>(`/events/feed?${q}`)).body
  it('filters by category or exact type, without wildcards or case folding', async () => {
    const byPrefix = await feed('type=invoice.&limit=200')
    expect(byPrefix.data.length).toBeGreaterThan(0)
    expect(byPrefix.data.every((e) => e.type.startsWith('invoice.'))).toBe(true)
    expect((await feed('type=invoice&limit=200')).data.map((e) => e.id)).toEqual(byPrefix.data.map((e) => e.id))
    const paid = await feed('type=invoice.paid&limit=200')
    expect(paid.data.every((e) => e.type === 'invoice.paid')).toBe(true)
    expect((await feed('type=%25&limit=5')).data).toEqual([]) // "%" is not a wildcard
    expect((await feed('type=in_oice.&limit=5')).data).toEqual([]) // "_" is not a wildcard
    expect((await feed('type=INVOICE.&limit=5')).data).toEqual([])
    expect((await feed('type=inv&limit=5')).data).toEqual([]) // not a partial-word prefix
  })
  it('treats cursor=0 as a cursor', async () => {
    expect((await feed('cursor=0')).data).toEqual([])
    const first = await feed('limit=3')
    const next = await feed(`limit=3&cursor=${first.nextCursor}`)
    expect(next.data[0]!.id).toBeLessThan(first.data[2]!.id)
  })
})
