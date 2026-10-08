import { makeApp } from '../../server/app.ts'

export function testApp(opts: { latencyMs?: number; failRate?: number } = {}) {
  const { app, runtime } = makeApp({
    db: {
      file: ':memory:',
      seed: true,
      seedOptions: { seed: 7, customers: 120, projects: 5, events: 50, now: new Date('2026-06-15T12:00:00Z') },
    },
    chaos: { latencyMs: opts.latencyMs ?? 0, failRate: opts.failRate ?? 0 },
  })
  const req = async <T = any>(method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T }
  }
  return { app, runtime, req, dispose: () => runtime.dispose() }
}
