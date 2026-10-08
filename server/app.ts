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
import { lookup } from './db/sql.ts'
import { events as eventsRepo, metrics } from './db/repo.ts'
import { DEMO_PASSWORD, DEMO_USERS, seed } from './db/seed.ts'
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
  /**
   * Demo features: public /auth/demo-users (with the shared password), /dev/*
   * (chaos, reset) and reseeding the database on a schema-version mismatch.
   * Default: on, unless NODE_ENV=production (then only with DEMO_MODE=1).
   */
  demo?: boolean
  /** Mark the session cookie Secure (default: NODE_ENV=production). */
  secureCookies?: boolean
}

const isProduction = () => process.env.NODE_ENV === 'production'
export const demoModeFromEnv = () => !isProduction() || process.env.DEMO_MODE === '1'

/** Failed sign-ins per email before /auth/login answers 429 for the rest of the window. */
const LOGIN_MAX_FAILURES = 10
const LOGIN_WINDOW_MS = 15 * 60_000

type Vars = { Variables: { me: Principal | null; requestId: string; sessionId: string | null } }
type Ctx = HonoContext<Vars>

export const toPrincipal = (me: Me): Principal => ({
  ...me,
  can: (p: Permission) => me.permissions.includes(p),
  privileged: isPrivilegedRole(me.user.role),
})

export function makeApp(opts: AppOptions) {
  const demo = opts.demo ?? demoModeFromEnv()
  const secureCookies = opts.secureCookies ?? isProduction()
  const sqliteLayer = Sqlite.layer({ ...opts.db, demo })
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
          // (through the writer, so it can never join - or be rolled back with - another request's transaction)
          Forbidden: (e) =>
            Writer.use((w) =>
              w.transaction(
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
                ),
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

  /**
   * Read the request body *before* any transaction starts: a slow client must
   * never hold the write lock, and the transactional program stays synchronous.
   */
  const readJson = (c: Ctx): Promise<unknown> => c.req.json().catch(() => null)
  const runWithBody = async <A>(
    c: Ctx,
    f: (input: unknown) => Program<A>,
    o: { status?: 200 | 201 | 204; write?: boolean } = {},
  ) => run(c, f(await readJson(c)), o)
  const decodeInput = <S extends Schema.Top>(schema: S, input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input) as unknown as Effect.Effect<S['Type'], Schema.SchemaError>
  const listParams = (c: Ctx) =>
    Effect.try({
      try: () => parseListParams(new URL(c.req.url).searchParams),
      catch: (e) => new BadRequest({ message: (e as Error).message }),
    })
  const idOf = (c: Ctx) => {
    const raw = c.req.param('id')!
    return lookup(resources, c.req.param('resource')!)?.keyType === 'number' ? Number(raw) : raw
  }

  const app = new Hono<Vars>().basePath('/api')

  // ---------------- request id + authentication ----------------
  const PUBLIC = new Set(['/api/auth/login', '/api/health', ...(demo ? ['/api/auth/demo-users'] : [])])
  app.use('*', async (c, next) => {
    // always server-generated: a client-chosen id could forge or collide audit trails
    const requestId = randomUUID()
    c.set('requestId', requestId)
    c.header('x-request-id', requestId)
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
  const notFound = (c: Ctx) =>
    c.json({ error: 'NotFound', message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}` }, 404)
  if (demo)
    app.get('/auth/demo-users', (c) =>
      c.json(DEMO_USERS.map(({ email, name, role, title }) => ({ email, name, role, title, password: DEMO_PASSWORD }))),
    )
  else app.get('/auth/demo-users', notFound)

  // per-email failed-login throttle (in memory, per process)
  const loginFailures = new Map<string, { count: number; resetAt: number }>()
  const throttled = (email: string) => {
    const f = loginFailures.get(email)
    if (f && f.resetAt <= Date.now()) loginFailures.delete(email)
    return (loginFailures.get(email)?.count ?? 0) >= LOGIN_MAX_FAILURES
  }
  const recordFailure = (email: string) => {
    if (loginFailures.size > 10_000) for (const [k, v] of loginFailures) if (v.resetAt <= Date.now()) loginFailures.delete(k)
    const f = loginFailures.get(email) ?? { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS }
    f.count++
    loginFailures.set(email, f)
  }
  app.post('/auth/login', async (c) => {
    const input = await readJson(c)
    return runtime.runPromise(
      Effect.gen(function* () {
        const creds = yield* decodeInput(LoginInput, input)
        const key = creds.email.trim().toLowerCase()
        if (throttled(key))
          return c.json({ error: 'TooManyRequests', message: 'Too many failed sign-in attempts; try again later' }, 429)
        const d = yield* database
        const writer = yield* Writer
        const user = yield* sql(() => authenticate(d, creds.email, creds.password))
        if (!user) {
          recordFailure(key)
          return yield* new Unauthorized({ message: 'Invalid email or password' })
        }
        loginFailures.delete(key)
        const sid = yield* writer.transaction(
          Effect.gen(function* () {
            const sid = yield* sql(() => createSession(d, user.id, c.req.header('user-agent')))
            yield* sql(() =>
              d
                .prepare(
                  `INSERT INTO audit_log (at, actor_id, action, entity, entity_id, changes, request_id) VALUES (?, ?, 'login', 'sessions', NULL, '{}', ?)`,
                )
                .run(new Date().toISOString(), user.id, c.get('requestId')),
            )
            return sid
          }),
        )
        setCookie(c, SESSION_COOKIE, sid, {
          httpOnly: true,
          sameSite: 'Lax',
          path: '/',
          maxAge: 7 * 24 * 3600,
          secure: secureCookies,
        })
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
    )
  })
  app.post('/auth/logout', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const d = yield* database
        const sid = c.get('sessionId')
        const gone = sid ? yield* sql(() => deleteSession(d, sid)) : undefined
        // tells the user's other tabs (session lists) and closes this session's change streams
        if (gone) yield* H.touch('sessions', gone.id, gone.userId)
        yield* H.audit('logout', 'sessions', null)
        deleteCookie(c, SESSION_COOKIE, { path: '/', secure: secureCookies })
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
    runWithBody(
      c,
      (body) =>
        Effect.gen(function* () {
          const input = (body && typeof body === 'object' ? body : {}) as object
          const data = yield* decodeInput(PaymentInput, { method: 'card', ...input, invoiceId: Number(c.req.param('id')) })
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
    runWithBody(
      c,
      (input) =>
        Effect.gen(function* () {
          const { ops } = yield* decodeInput(BatchRequest, input)
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

  /**
   * Server-sent change feed, filtered by what the caller is allowed to read.
   * The caller is re-resolved from their session before every delivery and
   * heartbeat: after logout, session revocation, expiry or deactivation the
   * stream closes; role/team changes apply to the very next message.
   */
  app.get('/events/stream', (c) =>
    streamSSE(c, async (stream) => {
      const token = c.get('sessionId')!
      let me = c.get('me')!
      const refresh = () => {
        const current = resolveSession(db(), token)
        if (current) me = toPrincipal(current)
        return current !== undefined
      }
      const feed = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* ChangeFeed
        }),
      )
      const visible = (m: ChangeMessage) => {
        if (m.kind === 'reset') return true
        const r = lookup(resources, m.entity)
        if (!r) return false
        if (r.read && !me.can(r.read)) return false
        if (r.ownerField) {
          const owner = m.kind === 'upsert' ? (m.row as Record<string, unknown>)[r.ownerField] : m.ownerId
          if (owner !== me.user.id) return false
        }
        return true
      }
      const queue: ChangeMessage[] = []
      let wake: (() => void) | undefined
      const unsubscribe = feed.subscribe((m) => {
        queue.push(m)
        wake?.()
      })
      stream.onAbort(() => {
        unsubscribe()
        wake?.()
      })
      await stream.writeSSE({ event: 'ready', data: '{}' })
      while (!stream.aborted) {
        if (queue.length) {
          if (!refresh()) break
          while (queue.length) {
            const m = queue.shift()!
            if (!visible(m)) continue
            const { ownerId: _owner, ...wire } = m as ChangeMessage & { ownerId?: number }
            await stream.writeSSE({ event: 'change', data: JSON.stringify(wire) })
          }
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        await new Promise<void>((r) => {
          wake = r
          timer = setTimeout(r, 15_000) // heartbeat
        })
        clearTimeout(timer)
        if (!queue.length && !stream.aborted) {
          if (!refresh()) break
          await stream.writeSSE({ event: 'ping', data: '' })
        }
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

  // ---------------- dev tools (demo mode only) ----------------
  if (!demo) app.all('/dev/*', notFound)
  app.get('/dev/chaos', (c) =>
    run(
      c,
      Effect.flatMap(requirePermission('admin:dev'), () => Chaos.use((ch) => ch.get)),
    ),
  )
  app.put('/dev/chaos', (c) =>
    runWithBody(c, (input) =>
      Effect.gen(function* () {
        yield* requirePermission('admin:dev')
        const cfg = yield* decodeInput(ChaosConfig, input)
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
        const writer = yield* Writer
        // under the write lock (not a transaction: the schema reset toggles pragmas)
        yield* writer.exclusive(
          sql(() => {
            // keep everyone signed in across the reset (user ids are deterministic)
            const sessions = d
              .prepare(`SELECT id, user_id, created_at, expires_at, user_agent FROM sessions`)
              .all() as unknown[][]
            seed(d, opts.db.seedOptions)
            const ins = d.prepare(
              `INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (@id, @user_id, @created_at, @expires_at, @user_agent)`,
            )
            for (const s of sessions) ins.run(s)
          }),
        )
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
    runWithBody(c, (b) => H.create(c.req.param('resource'), b) as Program<unknown>, { status: 201, write: true }),
  )
  app.patch('/:resource/:id', (c) =>
    runWithBody(c, (b) => H.update(c.req.param('resource'), idOf(c), b) as Program<unknown>, { write: true }),
  )
  app.delete('/:resource/:id', (c) =>
    run(c, H.remove(c.req.param('resource'), idOf(c)) as Program<unknown>, { status: 204, write: true }),
  )

  app.notFound((c) => c.json({ error: 'NotFound', message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}` }, 404))

  return { app, runtime }
}
