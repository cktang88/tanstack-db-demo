import { afterAll, describe, expect, it } from 'vite-plus/test'
import { Effect } from 'effect'
import { Sqlite } from '../../server/services.ts'
import { testApp, type Role } from './helpers.ts'

const dbOf = (app: ReturnType<typeof testApp>) =>
  app.runtime.runSync(
    Effect.gen(function* () {
      return yield* Sqlite
    }),
  )

const t = testApp()
afterAll(t.dispose)
const { app } = t

const login = async (role: Role) => {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${role}@saasly.dev`, password: 'password' }),
  })
  return ((await res.json()) as { token: string }).token
}
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
    const db = dbOf(t)
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
