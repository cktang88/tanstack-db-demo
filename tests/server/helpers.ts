import { makeApp } from '../../server/app.ts'

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
  return { app, runtime, req, as, dispose: () => runtime.dispose() }
}
