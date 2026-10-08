import { afterAll, describe, expect, it } from 'vite-plus/test'
import { testApp, type Role } from './helpers.ts'

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
