import { Context, Effect, Layer, Ref, Schema } from 'effect'
import type { ActivityEvent } from '../shared/domain.ts'
import type { ChaosConfig } from '../shared/schemas.ts'
import { openDatabase, type DB } from './db/schema.ts'
import { seed } from './db/seed.ts'
import { BadQuery } from './db/sql.ts'

// ---------------------------------------------------------------------------
// Typed errors. Every failure mode of a request is visible in the Effect type.
// ---------------------------------------------------------------------------
export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', { entity: Schema.String, id: Schema.Number }) {}
export class BadRequest extends Schema.TaggedError<BadRequest>()('BadRequest', { message: Schema.String }) {}
export class DbError extends Schema.TaggedError<DbError>()('DbError', { cause: Schema.Defect() }) {}
export class SimulatedFailure extends Schema.TaggedError<SimulatedFailure>()('SimulatedFailure', {}) {}

export type AppError = NotFound | BadRequest | DbError | SimulatedFailure | Schema.SchemaError

// ---------------------------------------------------------------------------
// Sqlite: the database handle as a scoped resource (closed on dispose).
// ---------------------------------------------------------------------------
export interface SqliteConfig {
  file: string
  seed?: boolean
  seedOptions?: Parameters<typeof seed>[1]
}

export class Sqlite extends Context.Service<Sqlite, DB>()('app/Sqlite') {
  static layer = (config: SqliteConfig) =>
    Layer.effect(
      Sqlite,
      Effect.acquireRelease(
        Effect.sync(() => {
          const db = openDatabase(config.file)
          const empty = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0
          if (config.seed || empty) seed(db, config.seedOptions)
          return db
        }),
        (db) => Effect.sync(() => db.close()),
      ),
    )
}

/** Run a synchronous better-sqlite3 call, mapping thrown errors into typed failures. */
export const sql = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: (cause) =>
      cause instanceof BadQuery
        ? new BadRequest({ message: cause.message })
        : String((cause as { code?: string })?.code).startsWith('SQLITE_CONSTRAINT')
          ? new BadRequest({ message: (cause as Error).message })
          : new DbError({ cause }),
  })

// ---------------------------------------------------------------------------
// Chaos: configurable latency + failure rate to demo optimistic UI & rollback.
// ---------------------------------------------------------------------------
export class Chaos extends Context.Service<
  Chaos,
  {
    get: Effect.Effect<ChaosConfig>
    set: (c: ChaosConfig) => Effect.Effect<ChaosConfig>
    /** Sleep for the configured latency; for writes, maybe fail. */
    apply: (isWrite: boolean) => Effect.Effect<void, SimulatedFailure>
  }
>()('app/Chaos') {
  static layer = (initial: ChaosConfig) =>
    Layer.effect(
      Chaos,
      Effect.gen(function* () {
        const ref = yield* Ref.make(initial)
        return Chaos.of({
          get: Ref.get(ref),
          set: (c) => Ref.set(ref, c).pipe(Effect.as(c)),
          apply: Effect.fn('Chaos.apply')(function* (isWrite: boolean) {
            const { latencyMs, failRate } = yield* Ref.get(ref)
            if (latencyMs > 0) yield* Effect.sleep(latencyMs)
            if (isWrite && failRate > 0 && Math.random() < failRate) return yield* new SimulatedFailure()
          }),
        })
      }),
    )
}

// ---------------------------------------------------------------------------
// ChangeFeed: in-process pub/sub that powers the SSE stream.
// ---------------------------------------------------------------------------
export type Entity = 'customers' | 'invoices' | 'projects' | 'tasks' | 'users' | 'events'
export type ChangeMessage =
  | { kind: 'upsert'; entity: Entity; row: { id: number } & Record<string, unknown> }
  | { kind: 'delete'; entity: Entity; id: number }
  | { kind: 'reset' }

export class ChangeFeed extends Context.Service<
  ChangeFeed,
  {
    publish: (m: ChangeMessage) => Effect.Effect<void>
    subscribe: (fn: (m: ChangeMessage) => void) => () => void
  }
>()('app/ChangeFeed') {
  static layer = Layer.sync(ChangeFeed, () => {
    const subs = new Set<(m: ChangeMessage) => void>()
    return ChangeFeed.of({
      publish: (m) =>
        Effect.sync(() => {
          for (const s of subs) s(m)
        }),
      subscribe: (fn) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
    })
  })
}

export const publishEvent = (e: ActivityEvent) =>
  ChangeFeed.use((f) => f.publish({ kind: 'upsert', entity: 'events', row: e as unknown as { id: number } }))
