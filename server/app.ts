import { Effect, Layer, ManagedRuntime, Schema } from 'effect'
import { Hono, type Context as HonoContext } from 'hono'
import { streamSSE } from 'hono/streaming'
import { PLAN_PRICE, type Customer } from '../shared/domain.ts'
import {
  ChaosConfig,
  CustomerInput,
  CustomerPatch,
  InvoicePatch,
  ProjectPatch,
  TaskInput,
  TaskPatch,
  UserPatch,
} from '../shared/schemas.ts'
import * as repo from './db/repo.ts'
import { parseListParams } from './db/params.ts'
import type { DB } from './db/schema.ts'
import type { ListParams } from './db/sql.ts'
import { seed } from './db/seed.ts'
import {
  BadRequest,
  Chaos,
  ChangeFeed,
  NotFound,
  Sqlite,
  sql,
  type AppError,
  type ChangeMessage,
  type Entity,
  type SqliteConfig,
} from './services.ts'

export interface AppOptions {
  db: SqliteConfig
  chaos?: { latencyMs: number; failRate: number }
}

type Services = Sqlite | Chaos | ChangeFeed

export function makeApp(opts: AppOptions) {
  const layer = Layer.mergeAll(Sqlite.layer(opts.db), Chaos.layer(opts.chaos ?? { latencyMs: 0, failRate: 0 }), ChangeFeed.layer)
  const runtime = ManagedRuntime.make(layer)

  /** Run an Effect program for a request and map typed errors to HTTP responses. */
  const run = <A>(c: HonoContext, program: Effect.Effect<A, AppError, Services>, status: 200 | 201 | 204 = 200) =>
    runtime.runPromise(
      program.pipe(
        Effect.map((body) => (status === 204 ? c.body(null, 204) : c.json(body as object, status))),
        Effect.catchTags({
          SchemaError: (e) => Effect.succeed(c.json({ error: 'BadRequest', message: e.message }, 400)),
          BadRequest: (e) => Effect.succeed(c.json({ error: 'BadRequest', message: e.message }, 400)),
          NotFound: (e) => Effect.succeed(c.json({ error: 'NotFound', message: `${e.entity} ${e.id} not found` }, 404)),
          SimulatedFailure: () =>
            Effect.succeed(c.json({ error: 'SimulatedFailure', message: 'Simulated server failure (chaos mode)' }, 503)),
          DbError: (e) =>
            Effect.logError('db error', e.cause).pipe(Effect.as(c.json({ error: 'Internal', message: 'Database error' }, 500))),
        }),
      ),
    )

  // ---------- small helpers ----------
  const db = Effect.gen(function* () {
    return yield* Sqlite
  })
  const idParam = (c: HonoContext) => Schema.decodeUnknownEffect(Schema.FiniteFromString.check(Schema.isInt()))(c.req.param('id'))
  const body = <S extends Schema.Top>(c: HonoContext, schema: S) =>
    Effect.promise(() => c.req.json().catch(() => null)).pipe(
      Effect.flatMap((json) => Schema.decodeUnknownEffect(schema)(json) as Effect.Effect<S['Type'], Schema.SchemaError>),
    )
  const listParams = (c: HonoContext) =>
    Effect.try({
      try: () => parseListParams(new URL(c.req.url).searchParams),
      catch: (e) => new BadRequest({ message: (e as Error).message }),
    })
  const orNotFound =
    (entity: string, id: number) =>
    <A>(a: A | undefined) =>
      a === undefined ? Effect.fail(new NotFound({ entity, id })) : Effect.succeed(a)
  const publish = (m: ChangeMessage) => ChangeFeed.use((f) => f.publish(m))
  const upsert = (entity: Entity, row: { id: number }) => publish({ kind: 'upsert', entity, row: row as never })
  const record = (e: Parameters<typeof repo.events.record>[1]) =>
    Effect.gen(function* () {
      const d = yield* db
      const ev = yield* sql(() => repo.events.record(d, e))
      yield* upsert('events', ev)
      return ev
    })
  const mrrOf = (c: Pick<Customer, 'plan' | 'seats' | 'status'>) => (c.status === 'active' ? PLAN_PRICE[c.plan] * c.seats : 0)
  const list = <T>(c: HonoContext, f: (d: DB, p: ListParams) => { rows: T[]; total: number }) =>
    Effect.gen(function* () {
      const p = yield* listParams(c)
      const d = yield* db
      return repo.toPage(yield* sql(() => f(d, p)), p)
    })

  const app = new Hono().basePath('/api')

  // Simulated network conditions for everything except the dev endpoints / streams.
  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (path.startsWith('/api/dev') || path.endsWith('/stream')) return next()
    const failed = await runtime.runPromise(
      Chaos.use((ch) => ch.apply(c.req.method !== 'GET')).pipe(
        Effect.as(false),
        Effect.catchTag('SimulatedFailure', () => Effect.succeed(true)),
      ),
    )
    if (failed) return c.json({ error: 'SimulatedFailure', message: 'Simulated server failure (chaos mode)' }, 503)
    return next()
  })

  // ---------- users ----------
  app.get('/users', (c) => run(c, list(c, repo.users.list)))
  app.patch('/users/:id', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const id = yield* idParam(c)
        const patch = yield* body(c, UserPatch)
        const d = yield* db
        const user = yield* sql(() => repo.users.update(d, id, patch)).pipe(Effect.flatMap(orNotFound('user', id)))
        yield* upsert('users', user)
        return user
      }),
    ),
  )

  // ---------- customers ----------
  app.get('/customers', (c) => run(c, list(c, repo.customers.list)))
  app.get('/customers/:id', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const id = yield* idParam(c)
        const d = yield* db
        return yield* sql(() => repo.customers.get(d, id)).pipe(Effect.flatMap(orNotFound('customer', id)))
      }),
    ),
  )
  app.post('/customers', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const input = yield* body(c, CustomerInput)
        const d = yield* db
        const customer = yield* sql(() => repo.customers.create(d, input, mrrOf(input)))
        yield* upsert('customers', customer)
        yield* record({
          type: 'customer.created',
          actorId: 1,
          customerId: customer.id,
          message: `New customer ${customer.company}`,
        })
        return customer
      }),
      201,
    ),
  )
  app.patch('/customers/:id', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const id = yield* idParam(c)
        const patch = yield* body(c, CustomerPatch)
        const d = yield* db
        const current = yield* sql(() => repo.customers.get(d, id)).pipe(Effect.flatMap(orNotFound('customer', id)))
        const next = { ...current, ...patch }
        const customer = yield* sql(() => repo.customers.update(d, id, { ...patch, mrr: mrrOf(next) })).pipe(
          Effect.flatMap(orNotFound('customer', id)),
        )
        yield* upsert('customers', customer)
        yield* record({
          type: 'customer.updated',
          actorId: 1,
          customerId: id,
          message: `Updated ${customer.company} (${Object.keys(patch).join(', ')})`,
        })
        return customer
      }),
    ),
  )
  app.delete('/customers/:id', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const id = yield* idParam(c)
        const d = yield* db
        const current = yield* sql(() => repo.customers.get(d, id)).pipe(Effect.flatMap(orNotFound('customer', id)))
        const invoiceIds = yield* sql(
          () => d.prepare('SELECT id FROM invoices WHERE customer_id = ?').all(id) as Array<{ id: number }>,
        )
        yield* sql(() => repo.customers.remove(d, id))
        yield* publish({ kind: 'delete', entity: 'customers', id })
        for (const i of invoiceIds) yield* publish({ kind: 'delete', entity: 'invoices', id: i.id })
        yield* record({ type: 'customer.deleted', actorId: 1, customerId: null, message: `Deleted customer ${current.company}` })
        return null
      }),
      204,
    ),
  )

  // ---------- invoices ----------
  app.get('/invoices', (c) => run(c, list(c, repo.invoices.list)))
  app.patch('/invoices/:id', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const id = yield* idParam(c)
        const patch = yield* body(c, InvoicePatch)
        const d = yield* db
        const before = yield* sql(() => repo.invoices.get(d, id)).pipe(Effect.flatMap(orNotFound('invoice', id)))
        const paidAt = patch.status === 'paid' && !before.paidAt ? new Date().toISOString() : patch.paidAt
        const invoice = yield* sql(() => repo.invoices.update(d, id, { ...patch, paidAt })).pipe(
          Effect.flatMap(orNotFound('invoice', id)),
        )
        yield* upsert('invoices', invoice)
        if (patch.status === 'paid' && before.status !== 'paid')
          yield* record({
            type: 'invoice.paid',
            actorId: 1,
            customerId: invoice.customerId,
            message: `Invoice ${invoice.number} marked paid`,
          })
        return invoice
      }),
    ),
  )

  // ---------- projects ----------
  app.get('/projects', (c) => run(c, list(c, repo.projects.list)))
  app.get('/projects/:id', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const id = yield* idParam(c)
        const d = yield* db
        return yield* sql(() => repo.projects.get(d, id)).pipe(Effect.flatMap(orNotFound('project', id)))
      }),
    ),
  )
  app.patch('/projects/:id', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const id = yield* idParam(c)
        const patch = yield* body(c, ProjectPatch)
        const d = yield* db
        const project = yield* sql(() => repo.projects.update(d, id, patch)).pipe(Effect.flatMap(orNotFound('project', id)))
        yield* upsert('projects', project)
        return project
      }),
    ),
  )

  // ---------- tasks ----------
  app.get('/tasks', (c) => run(c, list(c, repo.tasks.list)))
  app.post('/tasks', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const input = yield* body(c, TaskInput)
        const d = yield* db
        yield* sql(() => repo.projects.get(d, input.projectId)).pipe(Effect.flatMap(orNotFound('project', input.projectId)))
        const task = yield* sql(() => repo.tasks.create(d, input))
        yield* upsert('tasks', task)
        yield* record({ type: 'task.created', actorId: 1, customerId: null, message: `Created task "${task.title}"` })
        return task
      }),
      201,
    ),
  )
  app.patch('/tasks/:id', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const id = yield* idParam(c)
        const patch = yield* body(c, TaskPatch)
        const d = yield* db
        const task = yield* sql(() => repo.tasks.update(d, id, patch)).pipe(Effect.flatMap(orNotFound('task', id)))
        yield* upsert('tasks', task)
        if (patch.status)
          yield* record({
            type: 'task.updated',
            actorId: 1,
            customerId: null,
            message: `Moved task "${task.title}" to ${task.status}`,
          })
        return task
      }),
    ),
  )
  app.delete('/tasks/:id', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const id = yield* idParam(c)
        const d = yield* db
        const ok = yield* sql(() => repo.tasks.remove(d, id))
        if (!ok) return yield* new NotFound({ entity: 'task', id })
        yield* publish({ kind: 'delete', entity: 'tasks', id })
        return null
      }),
      204,
    ),
  )

  // ---------- events ----------
  app.get('/events', (c) => run(c, list(c, repo.events.list)))
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
        const d = yield* db
        return yield* sql(() => repo.events.page(d, q.cursor ?? null, q.limit ?? 30, q.type))
      }),
    ),
  )

  /** Server-sent change feed: every write is broadcast to connected clients. */
  app.get('/events/stream', (c) =>
    streamSSE(c, async (stream) => {
      const feed = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* ChangeFeed
        }),
      )
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

  // ---------- metrics ----------
  const monthsParam = (c: HonoContext) =>
    Schema.decodeUnknownEffect(Schema.FiniteFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 36 })))(
      c.req.query('months') ?? '12',
    )
  app.get('/metrics/overview', (c) =>
    run(
      c,
      Effect.flatMap(db, (d) => sql(() => repo.metrics.overview(d))),
    ),
  )
  app.get('/metrics/revenue', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const months = yield* monthsParam(c)
        const d = yield* db
        return yield* sql(() => repo.metrics.revenue(d, months))
      }),
    ),
  )
  app.get('/metrics/signups', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const months = yield* monthsParam(c)
        const d = yield* db
        return yield* sql(() => repo.metrics.signups(d, months))
      }),
    ),
  )
  app.get('/metrics/breakdown', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const by = yield* Schema.decodeUnknownEffect(Schema.Literals(['plan', 'country', 'status']))(c.req.query('by'))
        const d = yield* db
        return yield* sql(() => repo.metrics.breakdown(d, by))
      }),
    ),
  )
  app.get('/metrics/workload', (c) =>
    run(
      c,
      Effect.flatMap(db, (d) => sql(() => repo.metrics.workload(d))),
    ),
  )

  // ---------- dev tools ----------
  app.get('/dev/chaos', (c) =>
    run(
      c,
      Chaos.use((ch) => ch.get),
    ),
  )
  app.put('/dev/chaos', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const cfg = yield* body(c, ChaosConfig)
        return yield* Chaos.use((ch) => ch.set(cfg))
      }),
    ),
  )
  app.post('/dev/reset', (c) =>
    run(
      c,
      Effect.gen(function* () {
        const d = yield* db
        yield* sql(() => seed(d, opts.db.seedOptions))
        yield* publish({ kind: 'reset' })
        return { ok: true }
      }),
    ),
  )

  app.notFound((c) => c.json({ error: 'NotFound', message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}` }, 404))

  return { app, runtime }
}
