import { randomUUID } from 'node:crypto'
import { Effect, Layer, ManagedRuntime, Schema } from 'effect'
import { Hono, type Context as HonoContext } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import type { Me, Permission } from '../shared/domain.ts'
import { BatchRequest, ChaosConfig, LoginInput, PaymentInput } from '../shared/schemas.ts'
import {
  authenticate,
  createSession,
  deleteSession,
  isPrivilegedRole,
  loadMe,
  resolveSession,
  SESSION_COOKIE,
} from './auth/session.ts'
import { markOverdue, rebuildMrrSnapshots } from './db/jobs.ts'
import { parseListParams } from './db/params.ts'
import { events as eventsRepo, metrics } from './db/repo.ts'
import { DEMO_USERS, seed } from './db/seed.ts'
import type { DB } from './db/schema.ts'
import * as H from './handlers.ts'
import { resources } from './resources.ts'
import {
  BadRequest,
  Chaos,
  ChangeFeed,
  CurrentUser,
  RequestId,
  requirePermission,
  Sqlite,
  sql,
  Unauthorized,
  Writer,
  type AppError,
  type ChangeMessage,
  type Principal,
  type SqliteConfig,
} from './services.ts'

export interface AppOptions {
  db: SqliteConfig
  chaos?: { latencyMs: number; failRate: number }
}

type Vars = { Variables: { me: Principal | null; requestId: string; sessionId: string | null } }
type Ctx = HonoContext<Vars>

export const toPrincipal = (me: Me): Principal => ({
  ...me,
  can: (p: Permission) => me.permissions.includes(p),
  privileged: isPrivilegedRole(me.user.role),
})

export function makeApp(opts: AppOptions) {
  const sqliteLayer = Sqlite.layer(opts.db)
  const layer = Layer.mergeAll(
    sqliteLayer,
    Writer.layer.pipe(Layer.provide(sqliteLayer)),
    Chaos.layer(opts.chaos ?? { latencyMs: 0, failRate: 0 }),
    ChangeFeed.layer,
  )
  const runtime = ManagedRuntime.make(layer)
  const database = Effect.gen(function* () {
    return yield* Sqlite
  })
  let dbHandle: DB | undefined
  const db = () => (dbHandle ??= runtime.runSync(database))

  type Program<A> = Effect.Effect<A, AppError, Sqlite | Writer | Chaos | ChangeFeed | CurrentUser | RequestId | H.Outbox>

  /**
   * Run a request program: provide the caller + request id + an outbox, wrap
   * writes in a serialized transaction, publish change messages after commit,
   * and map every typed error to exactly one HTTP response.
   */
  const run = <A>(c: Ctx, program: Program<A>, o: { status?: 200 | 201 | 204; write?: boolean } = {}) => {
    const me = c.get('me')
    const outbox = { messages: [] as ChangeMessage[] }
    const status = o.status ?? 200
    const transactional: Program<A> = o.write
      ? Effect.gen(function* () {
          const writer = yield* Writer
          return yield* writer.transaction(program)
        })
      : program
    const full = transactional.pipe(
      Effect.tap(() =>
        Effect.gen(function* () {
          const feed = yield* ChangeFeed
          for (const m of outbox.messages) yield* feed.publish(m)
        }),
      ),
      Effect.provideService(CurrentUser, me!),
      Effect.provideService(RequestId, c.get('requestId')),
      Effect.provideService(H.Outbox, outbox),
    )
    return runtime.runPromise(
      full.pipe(
        Effect.map((b) => (status === 204 ? c.body(null, 204) : c.json(b as object, status))),
        Effect.catchTags({
          SchemaError: (e) => Effect.succeed(c.json({ error: 'BadRequest', message: e.message }, 400)),
          BadRequest: (e) => Effect.succeed(c.json({ error: 'BadRequest', message: e.message }, 400)),
          Unauthorized: (e) => Effect.succeed(c.json({ error: 'Unauthorized', message: e.message }, 401)),
          // denials are written to the (append-only) audit log outside the rolled-back transaction
          Forbidden: (e) =>
            sql(() =>
              db()
                .prepare(
                  `INSERT INTO audit_log (at, actor_id, action, entity, entity_id, changes, request_id) VALUES (?, ?, 'denied', ?, NULL, ?, ?)`,
                )
                .run(
                  new Date().toISOString(),
                  me?.user.id ?? null,
                  `${c.req.method} ${new URL(c.req.url).pathname}`,
                  JSON.stringify({ reason: e.message }),
                  c.get('requestId'),
                ),
            ).pipe(Effect.ignore, Effect.as(c.json({ error: 'Forbidden', message: e.message }, 403))),
          NotFound: (e) => Effect.succeed(c.json({ error: 'NotFound', message: `${e.entity} ${String(e.id)} not found` }, 404)),
          MethodNotAllowed: (e) => Effect.succeed(c.json({ error: 'MethodNotAllowed', message: e.message }, 405)),
          Conflict: (e) => Effect.succeed(c.json({ error: 'Conflict', message: e.message }, 409)),
          SimulatedFailure: () =>
            Effect.succeed(c.json({ error: 'SimulatedFailure', message: 'Simulated server failure (chaos mode)' }, 503)),
          DbError: (e) =>
            Effect.logError('db error', e.cause).pipe(Effect.as(c.json({ error: 'Internal', message: 'Database error' }, 500))),
        }),
      ),
    )
  }

  const body = <S extends Schema.Top>(c: Ctx, schema: S) =>
    Effect.promise(() => c.req.json().catch(() => null)).pipe(
      Effect.flatMap(
        (json) => Schema.decodeUnknownEffect(schema)(json) as unknown as Effect.Effect<S['Type'], Schema.SchemaError>,
      ),
    )
  const jsonBody = (c: Ctx) => Effect.promise(() => c.req.json().catch(() => null) as Promise<unknown>)
  const listParams = (c: Ctx) =>
    Effect.try({
      try: () => parseListParams(new URL(c.req.url).searchParams),
      catch: (e) => new BadRequest({ message: (e as Error).message }),
    })
  const idOf = (c: Ctx) => {
    const raw = c.req.param('id')!
    return resources[c.req.param('resource')!]?.keyType === 'number' ? Number(raw) : raw
  }

  const app = new Hono<Vars>().basePath('/api')

  // ---------------- request id + authentication ----------------
  const PUBLIC = new Set(['/api/auth/login', '/api/auth/demo-users', '/api/health'])
  app.use('*', async (c, next) => {
    c.set('requestId', c.req.header('x-request-id') ?? randomUUID())
    const path = new URL(c.req.url).pathname
    const bearer = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1]
    const sid = bearer ?? getCookie(c, SESSION_COOKIE) ?? null
    const me = sid ? resolveSession(db(), sid) : undefined
    c.set('sessionId', me ? sid : null)
    c.set('me', me ? toPrincipal(me) : null)
    if (!me && !PUBLIC.has(path)) return c.json({ error: 'Unauthorized', message: 'Sign in required' }, 401)
    return next()
  })

  // ---------------- simulated network conditions ----------------
  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (path.startsWith('/api/dev') || path.startsWith('/api/auth') || path.endsWith('/stream')) return next()
    const failed = await runtime.runPromise(
      Chaos.use((ch) => ch.apply(c.req.method !== 'GET')).pipe(
        Effect.as(false),
        Effect.catchTag('SimulatedFailure', () => Effect.succeed(true)),
      ),
    )
    if (failed) return c.json({ error: 'SimulatedFailure', message: 'Simulated server failure (chaos mode)' }, 503)
    return next()
  })

  app.get('/health', (c) => c.json({ ok: true }))

  // ---------------- auth ----------------
  app.get('/auth/demo-users', (c) =>
    c.json(DEMO_USERS.map(({ email, name, role, title }) => ({ email, name, role, title, password: 'password' }))),
  )
  app.post('/auth/login', (c) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const creds = yield* body(c, LoginInput)
        const d = yield* database
        const user = yield* sql(() => authenticate(d, creds.email, creds.password))
        if (!user) return yield* new Unauthorized({ message: 'Invalid email or password' })
        const sid = yield* sql(() => createSession(d, user.id, c.req.header('user-agent')))
        yield* sql(() =>
          d
            .prepare(
              `INSERT INTO audit_log (at, actor_id, action, entity, entity_id, changes, request_id) VALUES (?, ?, 'login', 'sessions', NULL, '{}', ?)`,
            )
            .run(new Date().toISOString(), user.id, c.get('requestId')),
        )
        setCookie(c, SESSION_COOKIE, sid, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 7 * 24 * 3600 })
        return c.json({ ...loadMe(d, user), token: sid })
      }).pipe(
        Effect.catchTags({
          SchemaError: (e) => Effect.succeed(c.json({ error: 'BadRequest', message: e.message }, 400)),
          Unauthorized: (e) => Effect.succeed(c.json({ error: 'Unauthorized', message: e.message }, 401)),
          BadRequest: (e) => Effect.succeed(c.json({ error: 'BadRequest', message: e.message }, 400)),
          Conflict: (e) => Effect.succeed(c.json({ error: 'Conflict', message: e.message }, 409)),
          Forbidden: (e) => Effect.succeed(c.json({ error: 'Forbidden', message: e.message }, 403)),
          NotFound: (e) => Effect.succeed(c.json({ error: 'NotFound', message: String(e.id) }, 404)),
          MethodNotAllowed: (e) => Effect.succeed(c.json({ error: 'MethodNotAllowed', message: e.message }, 405)),
          DbError: () => Effect.succeed(c.json({ error: 'Internal', message: 'Database error' }, 500)),
        }),
      ),
    ),
  )
  app.post('/auth/logout', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const d = yield* database
        const sid = c.get('sessionId')
        if (sid) yield* sql(() => deleteSession(d, sid))
        yield* H.audit('logout', 'sessions', null)
        deleteCookie(c, SESSION_COOKIE, { path: '/' })
        return null
      }),
      { status: 204, write: true },
    ),
  )
  app.get('/auth/me', (c) => {
    const me = c.get('me')!
    return c.json({ user: me.user, permissions: me.permissions, teamIds: me.teamIds } satisfies Me)
  })

  // ---------------- business endpoints ----------------
  app.post('/invoices/:id/pay', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const input = ((yield* jsonBody(c)) ?? {}) as object
        const data = (yield* Schema.decodeUnknownEffect(PaymentInput)({
          method: 'card',
          ...input,
          invoiceId: Number(c.req.param('id')),
        })) as typeof PaymentInput.Type
        return yield* H.recordPayment(data)
      }) as Program<unknown>,
      { status: 201, write: true },
    ),
  )
  app.post('/notifications/read-all', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const d = yield* database
        const me = yield* CurrentUser
        const ids = yield* sql(() =>
          (
            d
              .prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL RETURNING id`)
              .all(new Date().toISOString(), me.user.id) as Array<{
              id: number
            }>
          ).map((r) => r.id),
        )
        for (const id of ids) yield* H.touch('notifications', id)
        return { updated: ids.length }
      }),
      { write: true },
    ),
  )

  /** Atomic multi-entity write: every op goes through the same authorization/validation as REST, in one transaction. */
  app.post('/batch', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const { ops } = yield* body(c, BatchRequest)
        const results: Array<{ entity: string; op: string; id: unknown; row?: unknown }> = []
        for (const op of ops) {
          if (op.op === 'insert') {
            const row = (yield* H.create(op.entity, op.data)) as { id: unknown }
            results.push({ entity: op.entity, op: op.op, id: row.id, row })
          } else if (op.op === 'update') {
            if (op.id === undefined) return yield* new BadRequest({ message: 'update requires id' })
            const row = (yield* H.update(op.entity, op.id, op.data)) as { id: unknown }
            results.push({ entity: op.entity, op: op.op, id: op.id, row })
          } else {
            if (op.id === undefined) return yield* new BadRequest({ message: 'delete requires id' })
            yield* H.remove(op.entity, op.id)
            results.push({ entity: op.entity, op: op.op, id: op.id })
          }
        }
        return { results }
      }) as Program<unknown>,
      { write: true },
    ),
  )

  // ---------------- activity feed ----------------
  app.get('/events/feed', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const q = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            cursor: Schema.optionalKey(Schema.FiniteFromString.check(Schema.isInt())),
            limit: Schema.optionalKey(
              Schema.FiniteFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 })),
            ),
            type: Schema.optionalKey(Schema.String),
          }),
        )(c.req.query())
        const d = yield* database
        return yield* sql(() => eventsRepo.page(d, q.cursor ?? null, q.limit ?? 30, q.type))
      }),
    ),
  )

  /** Server-sent change feed, filtered by what the caller is allowed to read. */
  app.get('/events/stream', (c) =>
    streamSSE(c, async (stream) => {
      const me = c.get('me')!
      const feed = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* ChangeFeed
        }),
      )
      const visible = (m: ChangeMessage) => {
        if (m.kind === 'reset') return true
        const r = resources[m.entity]
        if (!r) return false
        if (r.read && !me.can(r.read)) return false
        if (r.ownerField && m.kind === 'upsert' && (m.row as Record<string, unknown>)[r.ownerField] !== me.user.id) return false
        return true
      }
      const queue: ChangeMessage[] = []
      let wake: (() => void) | undefined
      const unsubscribe = feed.subscribe((m) => {
        if (!visible(m)) return
        queue.push(m)
        wake?.()
      })
      stream.onAbort(() => {
        unsubscribe()
        wake?.()
      })
      await stream.writeSSE({ event: 'ready', data: '{}' })
      while (!stream.aborted) {
        while (queue.length) await stream.writeSSE({ event: 'change', data: JSON.stringify(queue.shift()) })
        await new Promise<void>((r) => {
          wake = r
          setTimeout(r, 15_000) // heartbeat
        })
        if (!queue.length && !stream.aborted) await stream.writeSSE({ event: 'ping', data: '' })
      }
      unsubscribe()
    }),
  )

  // ---------------- metrics (server-side aggregates) ----------------
  const monthsParam = (c: Ctx) =>
    Schema.decodeUnknownEffect(Schema.FiniteFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 36 })))(
      c.req.query('months') ?? '12',
    )
  const metric = <A>(c: Ctx, perm: Permission, f: (d: DB) => A) =>
    run(
      c,
      Effect.gen(function* () {
        yield* requirePermission(perm)
        const d = yield* database
        return yield* sql(() => f(d))
      }),
    )
  app.get('/metrics/overview', (c) => metric(c, 'customers:read', metrics.overview))
  app.get('/metrics/workload', (c) => metric(c, 'projects:read', metrics.workload))
  app.get('/metrics/ar-aging', (c) => metric(c, 'billing:read', metrics.arAging))
  app.get('/metrics/revenue', (c) =>
    run(
      c,
      Effect.gen(function* () {
        yield* requirePermission('billing:read')
        const months = yield* monthsParam(c)
        const d = yield* database
        return yield* sql(() => metrics.revenue(d, months))
      }),
    ),
  )
  app.get('/metrics/signups', (c) =>
    run(
      c,
      Effect.gen(function* () {
        yield* requirePermission('customers:read')
        const months = yield* monthsParam(c)
        const d = yield* database
        return yield* sql(() => metrics.signups(d, months))
      }),
    ),
  )
  app.get('/metrics/breakdown', (c) =>
    run(
      c,
      Effect.gen(function* () {
        yield* requirePermission('customers:read')
        const by = yield* Schema.decodeUnknownEffect(Schema.Literals(['plan', 'country', 'status']))(c.req.query('by'))
        const d = yield* database
        return yield* sql(() => metrics.breakdown(d, by))
      }),
    ),
  )

  // ---------------- jobs (rollups) ----------------
  app.post('/jobs/mark-overdue', (c) =>
    run(
      c,
      Effect.gen(function* () {
        yield* requirePermission('billing:write')
        const d = yield* database
        const changed = yield* sql(() => markOverdue(d))
        yield* H.audit('update', 'jobs', null, undefined, { job: 'mark-overdue', changed })
        return { changed }
      }),
      { write: true },
    ),
  )
  app.post('/jobs/rebuild-mrr', (c) =>
    run(
      c,
      Effect.gen(function* () {
        yield* requirePermission('billing:write')
        const d = yield* database
        const months = yield* sql(() => rebuildMrrSnapshots(d))
        const all = yield* sql(() =>
          (d.prepare(`SELECT month FROM mrr_snapshots`).all() as Array<{ month: string }>).map((r) => r.month),
        )
        for (const m of all) yield* H.touch('mrr-snapshots', m)
        yield* H.audit('update', 'jobs', null, undefined, { job: 'rebuild-mrr', months })
        return { months }
      }),
      { write: true },
    ),
  )

  // ---------------- dev tools ----------------
  app.get('/dev/chaos', (c) =>
    run(
      c,
      Effect.flatMap(requirePermission('admin:dev'), () => Chaos.use((ch) => ch.get)),
    ),
  )
  app.put('/dev/chaos', (c) =>
    run(
      c,
      Effect.gen(function* () {
        yield* requirePermission('admin:dev')
        const cfg = yield* body(c, ChaosConfig)
        return yield* Chaos.use((ch) => ch.set(cfg))
      }),
    ),
  )
  app.post('/dev/reset', (c) =>
    run(
      c,
      Effect.gen(function* () {
        yield* requirePermission('admin:dev')
        const d = yield* database
        yield* sql(() => {
          // keep everyone signed in across the reset (user ids are deterministic)
          const sessions = d.prepare(`SELECT id, user_id, created_at, expires_at, user_agent FROM sessions`).all() as unknown[][]
          seed(d, opts.db.seedOptions)
          const ins = d.prepare(
            `INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (@id, @user_id, @created_at, @expires_at, @user_agent)`,
          )
          for (const s of sessions) ins.run(s)
        })
        const feed = yield* ChangeFeed
        yield* feed.publish({ kind: 'reset' })
        return { ok: true }
      }),
    ),
  )

  // ---------------- generic resource routes (every table) ----------------
  app.get('/resources', (c) =>
    c.json(
      Object.values(resources).map((r) => ({
        name: r.name,
        mode: r.mode,
        read: r.read ?? 'signed-in',
        create: r.create ?? null,
        update: r.update ?? null,
        remove: r.remove ?? null,
        fields: Object.keys(r.columns),
      })),
    ),
  )
  app.get('/:resource', (c) =>
    run(
      c,
      Effect.flatMap(listParams(c), (p) => H.list(c.req.param('resource'), p)),
    ),
  )
  app.get('/:resource/:id', (c) => run(c, H.get(c.req.param('resource'), idOf(c))))
  app.post('/:resource', (c) =>
    run(c, Effect.flatMap(jsonBody(c), (b) => H.create(c.req.param('resource'), b)) as Program<unknown>, {
      status: 201,
      write: true,
    }),
  )
  app.patch('/:resource/:id', (c) =>
    run(c, Effect.flatMap(jsonBody(c), (b) => H.update(c.req.param('resource'), idOf(c), b)) as Program<unknown>, {
      write: true,
    }),
  )
  app.delete('/:resource/:id', (c) =>
    run(c, H.remove(c.req.param('resource'), idOf(c)) as Program<unknown>, { status: 204, write: true }),
  )

  app.notFound((c) => c.json({ error: 'NotFound', message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}` }, 404))

  return { app, runtime }
}
