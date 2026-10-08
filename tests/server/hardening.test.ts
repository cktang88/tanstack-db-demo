import { afterAll, describe, expect, it } from 'vite-plus/test'
import { testApp } from './helpers.ts'

const t = testApp()
afterAll(t.dispose)
const { app } = t

const { login } = t
const auth = (token: string) => ({ authorization: `Bearer ${token}` })

describe('write transactions', () => {
  it('reads the body before BEGIN: a slow failing batch cannot roll back a concurrent login', async () => {
    const owner = await login('owner')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        ctrl.enqueue(enc.encode('{"ops":[{"entity":"tasks","op":"update","id":99999999,'))
        await gate
        ctrl.enqueue(enc.encode('"data":{"status":"done"}}]}'))
        ctrl.close()
      },
    })
    const batch = app.request('/api/batch', {
      method: 'POST',
      headers: { ...auth(owner), 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit)
    await new Promise((r) => setTimeout(r, 20))
    const member = await login('member') // runs while the batch body is still streaming
    release()
    expect((await batch).status).toBe(404) // the batch fails and rolls back...
    const me = await app.request('/api/auth/me', { headers: auth(member) })
    expect(me.status).toBe(200) // ...but the login's session survived
  })
})

describe('prototype keys', () => {
  it('treats Object.prototype names as unknown resources / fields', async () => {
    const owner = t.as('owner')
    expect((await owner.get('/__proto__')).status).toBe(404)
    expect((await owner.get('/constructor')).status).toBe(404)
    expect((await owner.get('/toString/1')).status).toBe(404)
    expect((await owner.get('/customers?sort=constructor')).status).toBe(400)
    expect((await owner.get('/customers?sort=__proto__')).status).toBe(400)
    expect((await owner.get('/customers?constructor=1')).status).toBe(400)
    expect((await owner.get('/customers?hasOwnProperty[eq]=1')).status).toBe(400)
    expect((await owner.post('/constructor', {})).status).toBe(404)
  })
})

describe('list windows', () => {
  it('bounds ?offset= without a limit', async () => {
    const r = await t.as('owner').get('/usage-events?offset=1')
    expect(r.status).toBe(200)
    expect(r.body.data.length).toBeLessThanOrEqual(10_000)
    expect(r.body.pageSize).toBe(10_000)
  })
})

describe('demo features outside demo mode', () => {
  it('hides demo accounts and dev tools, keeps the API working', async () => {
    const prod = testApp({ demo: false, secureCookies: true })
    try {
      expect((await prod.as('anon').get('/auth/demo-users')).status).toBe(401) // no longer public
      expect((await prod.as('viewer').get('/auth/demo-users')).status).toBe(404)
      expect((await prod.as('owner').get('/dev/chaos')).status).toBe(404)
      expect((await prod.as('owner').post('/dev/reset')).status).toBe(404)
      expect((await prod.as('owner').get('/customers?limit=1')).status).toBe(200)
      const res = await prod.app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'viewer@saasly.dev', password: 'password' }),
      })
      expect(res.headers.get('set-cookie')).toMatch(/;\s*Secure/i)
    } finally {
      await prod.dispose()
    }
  })
  it('keeps demo features in dev/test', async () => {
    expect((await t.as('anon').get('/auth/demo-users')).status).toBe(200)
    expect((await t.as('owner').get('/dev/chaos')).status).toBe(200)
  })
  it('refuses to wipe a non-empty database on a schema mismatch', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { makeApp } = await import('../../server/app.ts')
    const dir = mkdtempSync(join(tmpdir(), 'saasly-'))
    const file = join(dir, 'db.sqlite')
    try {
      const seeded = makeApp({ demo: true, db: { file, seed: true, seedOptions: { customers: 5, projects: 1, events: 1 } } })
      await seeded.runtime.context()
      await seeded.runtime.dispose()
      const Database = (await import('better-sqlite3')).default
      const raw = new Database(file)
      raw.pragma('user_version = 1')
      raw.close()
      const prod = makeApp({ demo: false, db: { file } })
      await expect(prod.runtime.context()).rejects.toThrow(/schema version/)
      await prod.runtime.dispose().catch(() => {})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('sessions & sign-in', () => {
  it('stores only a hash of the session token', async () => {
    const token = await login('billing')
    const db = t.db()
    const ids = (db.prepare(`SELECT id FROM sessions`).all() as Array<{ id: string }>).map((r) => r.id)
    expect(ids).not.toContain(token)
    const mine = await app.request('/api/sessions', { headers: auth(token) })
    const rows = ((await mine.json()) as { data: Array<Record<string, unknown>> }).data
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(rows.every((r) => typeof r.id === 'number')).toBe(true)
    // logout revokes it
    expect((await app.request('/api/auth/logout', { method: 'POST', headers: auth(token) })).status).toBe(204)
    expect((await app.request('/api/auth/me', { headers: auth(token) })).status).toBe(401)
  })
  it('throttles repeated failures per email without affecting others', async () => {
    const attempt = (email: string, password: string) =>
      app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
    for (let i = 0; i < 10; i++) expect((await attempt('viewer@saasly.dev', 'wrong')).status).toBe(401)
    expect((await attempt('viewer@saasly.dev', 'password')).status).toBe(429)
    expect((await attempt('nobody@saasly.dev', 'wrong')).status).toBe(401) // unknown users still verified (dummy hash)
    expect((await attempt('admin@saasly.dev', 'password')).status).toBe(200)
  })
})

describe('request ids & error messages', () => {
  it('ignores client-supplied request ids', async () => {
    const token = await login('owner')
    const res = await app.request('/api/projects/2', {
      method: 'PATCH',
      headers: { ...auth(token), 'content-type': 'application/json', 'x-request-id': 'forged-id' },
      body: JSON.stringify({ budgetHours: 77 }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-request-id')).not.toBe('forged-id')
    const log = (await t.as('owner').get('/audit-log?entity=projects&sort=-id&limit=1')).body.data[0]
    expect(log.requestId).toBe(res.headers.get('x-request-id'))
  })
  it('does not leak SQLite constraint messages', async () => {
    const r = await t.as('owner').post('/tags', { name: 'strategic', color: '#123456' })
    expect(r.status).toBe(409)
    expect(r.body.message).not.toMatch(/constraint|tags\.name/i)
  })
})

const { openStream } = t

describe('change stream authorization', () => {
  it('delivers deletes of per-user rows only to their owner', async () => {
    const member = await login('member')
    const s = await openStream(member)
    try {
      const extra = await login('owner')
      const mine = await app.request('/api/sessions?sort=-id&limit=1', { headers: auth(extra) })
      const sid = ((await mine.json()) as { data: Array<{ id: number }> }).data[0]!.id
      expect((await app.request(`/api/sessions/${sid}`, { method: 'DELETE', headers: auth(extra) })).status).toBe(204)
      await t.as('owner').patch('/customers/7', { country: 'SE' })
      await s.until(() => s.changes().some((m) => m.entity === 'customers' && m.row?.id === 7))
      expect(s.changes().filter((m) => m.entity === 'sessions')).toEqual([])
      expect(s.changes().every((m) => !('ownerId' in m))).toBe(true)
    } finally {
      await s.cancel()
    }
  })
  it('closes the stream when the session is logged out', async () => {
    const member = await login('member')
    const s = await openStream(member)
    expect((await app.request('/api/auth/logout', { method: 'POST', headers: auth(member) })).status).toBe(204)
    await s.until(s.closed)
  })
  it('closes the stream when the user is deactivated', async () => {
    const owner = t.as('owner')
    const user = (await owner.get('/users?role=member&id[gt]=5&active=true&limit=1')).body.data[0]
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password: 'password' }),
    })
    const token = ((await res.json()) as { token: string }).token
    const s = await openStream(token)
    expect((await owner.patch(`/users/${user.id}`, { active: false })).status).toBe(200)
    await s.until(s.closed)
  })
})

describe('project & task row-level rules', () => {
  const setup = async () => {
    const owner = t.as('owner')
    const memberTeams: number[] = (await t.as('member').get('/auth/me')).body.teamIds
    const teams: Array<{ id: number }> = (await owner.get('/teams')).body.data
    const otherTeam = teams.find((x) => !memberTeams.includes(x.id))!.id
    const project = (
      await owner.post('/projects', {
        name: 'Elsewhere',
        description: '',
        customerId: null,
        ownerId: 1,
        teamId: otherTeam,
        status: 'active',
        budgetHours: 10,
      })
    ).body
    const task = (
      await owner.post('/tasks', {
        projectId: project.id,
        title: 'Assigned to member',
        status: 'todo',
        priority: 'low',
        assigneeId: 4,
        dueDate: null,
      })
    ).body
    return { otherTeam, project, task }
  }

  it('members cannot move a project to another team or hand it to someone else', async () => {
    const { otherTeam } = await setup()
    const member = t.as('member')
    expect((await member.patch('/projects/1', { teamId: otherTeam, ownerId: 4 })).status).toBe(403)
    expect((await member.patch('/projects/1', { ownerId: 2 })).status).toBe(403)
    expect((await member.patch('/projects/1', { ownerId: 4 })).status).toBe(200)
    const input = { name: 'Mine', description: '', customerId: null, teamId: 1, status: 'planning', budgetHours: 1 }
    expect((await member.post('/projects', { ...input, ownerId: 2 })).status).toBe(403)
    expect((await member.post('/projects', { ...input, ownerId: 4 })).status).toBe(201)
    expect((await member.post('/projects', { ...input, ownerId: null, teamId: otherTeam })).status).toBe(403)
  })

  it('a task assignee outside the project team may only move the card', async () => {
    const { project, task } = await setup()
    const member = t.as('member')
    expect((await member.patch(`/tasks/${task.id}`, { status: 'in_progress', position: 3 })).status).toBe(200)
    expect((await member.patch(`/tasks/${task.id}`, { title: 'Renamed by assignee' })).status).toBe(403)
    expect((await member.patch(`/tasks/${task.id}`, { projectId: 1 })).status).toBe(403)
    expect((await member.del(`/tasks/${task.id}`)).status).toBe(403)
    const input = { title: 'Sneaky', status: 'todo', priority: 'low', assigneeId: 4, dueDate: null }
    expect((await member.post('/tasks', { ...input, projectId: project.id })).status).toBe(403)
    const own = (await member.post('/tasks', { ...input, projectId: 1 })).body
    expect((await member.patch(`/tasks/${own.id}`, { projectId: project.id })).status).toBe(403)
  })
})

describe('client-chosen ids', () => {
  it('accepts client id generators (≈ Date.now() * 1000) but rejects ids near the float precision limit', async () => {
    const owner = t.as('owner')
    const ok = Date.now() * 1000 + 7
    expect((await owner.post('/tags', { id: ok, name: 'client-id', color: '#123456' })).body.id).toBe(ok)
    expect((await owner.post('/tags', { id: 2 ** 53 + 2, name: 'too-big', color: '#123456' })).status).toBe(400)
    expect((await owner.post('/tags', { id: 2 ** 52 + 1, name: 'too-big', color: '#123456' })).status).toBe(400)
    // the next autoincrement id is still exact
    const next = (await owner.post('/tags', { name: 'after-client-id', color: '#123456' })).body.id
    expect(next).toBe(ok + 1)
  })
})

describe('audit trail', () => {
  it('records what a delete removed, and text keys', async () => {
    const owner = t.as('owner')
    const tag = (await owner.post('/tags', { name: 'audited', color: '#abcdef' })).body
    expect((await owner.post('/customer-tags', { customerId: 9, tagId: tag.id })).status).toBe(201)
    expect((await owner.del(`/customer-tags/9:${tag.id}`)).status).toBe(204)
    const log = (await owner.get(`/audit-log?entity=customer-tags&action=delete&sort=-id&limit=1`)).body.data[0]
    expect(log.entityKey).toBe(`9:${tag.id}`)
    expect(JSON.parse(log.changes)).toMatchObject({ customerId: [9, null], tagId: [tag.id, null] })
    expect((await owner.del(`/tags/${tag.id}`)).status).toBe(204)
    const tagLog = (await owner.get(`/audit-log?entity=tags&entityId=${tag.id}&action=delete`)).body.data[0]
    expect(tagLog.entityKey).toBe(String(tag.id))
    expect(JSON.parse(tagLog.changes).name).toEqual(['audited', null])
  })
})

describe('schema', () => {
  it('keeps the activity feed append-only', () => {
    const db = t.db()
    expect(() => db.prepare(`DELETE FROM events WHERE id = 1`).run()).toThrow(/append-only/)
    expect(() => db.prepare(`UPDATE events SET message = 'x' WHERE id = 1`).run()).toThrow(/append-only/)
  })
  it('serves default sorts from an index', () => {
    const db = t.db()
    const plan = (q: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${q}`).all() as Array<{ detail: string }>).map((r) => r.detail).join('\n')
    for (const q of [
      `SELECT * FROM payments ORDER BY received_at DESC, id ASC LIMIT 25`,
      `SELECT * FROM usage_events ORDER BY occurred_at DESC, id ASC LIMIT 25`,
      `SELECT * FROM time_entries ORDER BY spent_on DESC, id ASC LIMIT 25`,
      `SELECT * FROM tasks WHERE project_id = 1 ORDER BY position ASC, id ASC`,
    ])
      expect(plan(q), q).not.toMatch(/TEMP B-TREE/)
  })
})
