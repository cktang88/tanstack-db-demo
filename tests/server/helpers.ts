import { Effect } from 'effect'
import { makeApp } from '../../server/app.ts'
import { Sqlite } from '../../server/services.ts'

export type Role = 'owner' | 'admin' | 'billing' | 'member' | 'viewer'

export function testApp(opts: { latencyMs?: number; failRate?: number; demo?: boolean; secureCookies?: boolean } = {}) {
  const { app, runtime } = makeApp({
    demo: opts.demo,
    secureCookies: opts.secureCookies,
    db: {
      file: ':memory:',
      seed: true,
      seedOptions: { seed: 7, customers: 120, projects: 5, events: 50, usageDays: 7, now: new Date('2026-06-15T12:00:00Z') },
    },
    chaos: { latencyMs: opts.latencyMs ?? 0, failRate: opts.failRate ?? 0 },
  })
  const sessions: Partial<Record<Role | 'anon', string>> = {}
  const req = async <T = any>(method: string, path: string, body?: unknown, as: Role | 'anon' = 'owner') => {
    if (as !== 'anon' && !sessions[as]) {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `${as}@saasly.dev`, password: 'password' }),
      })
      sessions[as] = ((await res.json()) as { token: string }).token
    }
    const res = await app.request(`/api${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(as !== 'anon' ? { authorization: `Bearer ${sessions[as]}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T }
  }
  const as = (role: Role | 'anon') => ({
    get: <T = any>(p: string) => req<T>('GET', p, undefined, role),
    post: <T = any>(p: string, b?: unknown) => req<T>('POST', p, b ?? {}, role),
    patch: <T = any>(p: string, b: unknown) => req<T>('PATCH', p, b, role),
    del: <T = any>(p: string) => req<T>('DELETE', p, undefined, role),
  })
  /** a fresh session (independent of the cached per-role ones) */
  const login = async (role: Role) => {
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${role}@saasly.dev`, password: 'password' }),
    })
    return ((await res.json()) as { token: string }).token
  }
  /** the raw database handle, for asserting on state the API (rightly) hides */
  const db = () =>
    runtime.runSync(
      Effect.gen(function* () {
        return yield* Sqlite
      }),
    )
  /** open the SSE change stream and collect its events */
  const openStream = async (token: string) => {
    const res = await app.request('/api/events/stream', { headers: { authorization: `Bearer ${token}` } })
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    const events: Array<{ event?: string; data?: string }> = []
    let buf = ''
    let closed = false
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
        if (done) return void (closed = true)
        buf += dec.decode(value)
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const chunk = buf.slice(0, i)
          buf = buf.slice(i + 2)
          events.push({ event: /^event: (.*)$/m.exec(chunk)?.[1], data: /^data: (.*)$/m.exec(chunk)?.[1] })
        }
      }
    })()
    const until = async (pred: () => boolean, ms = 3000) => {
      const start = Date.now()
      while (!pred()) {
        if (Date.now() - start > ms) throw new Error('timed out waiting for the stream')
        await new Promise((r) => setTimeout(r, 5))
      }
    }
    const changes = (): any[] => events.filter((e) => e.event === 'change').map((e) => JSON.parse(e.data!))
    await until(() => events.some((e) => e.event === 'ready'))
    return { events, changes, until, closed: () => closed, cancel: () => reader.cancel().catch(() => {}) }
  }
  return { app, runtime, req, as, login, db, openStream, dispose: () => runtime.dispose() }
}
