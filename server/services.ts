import { Context, Effect, Layer, Ref, Schema, Semaphore } from 'effect'
import type { Me, Permission } from '../shared/domain.ts'
import type { ChaosConfig } from '../shared/schemas.ts'
import { openDatabase, type DB } from './db/schema.ts'
import { seed } from './db/seed.ts'
import { BadQuery } from './db/sql.ts'

// ---------------------------------------------------------------------------
// Typed errors. Every failure mode of a request is visible in the Effect type
// and mapped to exactly one HTTP status at the edge (see app.ts).
// ---------------------------------------------------------------------------
export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', { entity: Schema.String, id: Schema.Unknown }) {}
export class BadRequest extends Schema.TaggedError<BadRequest>()('BadRequest', { message: Schema.String }) {}
export class Unauthorized extends Schema.TaggedError<Unauthorized>()('Unauthorized', { message: Schema.String }) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()('Forbidden', { message: Schema.String }) {}
export class Conflict extends Schema.TaggedError<Conflict>()('Conflict', { message: Schema.String }) {}
export class MethodNotAllowed extends Schema.TaggedError<MethodNotAllowed>()('MethodNotAllowed', { message: Schema.String }) {}
export class DbError extends Schema.TaggedError<DbError>()('DbError', { cause: Schema.Defect() }) {}
export class SimulatedFailure extends Schema.TaggedError<SimulatedFailure>()('SimulatedFailure', {}) {}

export type AppError =
  | NotFound
  | BadRequest
  | Unauthorized
  | Forbidden
  | Conflict
  | MethodNotAllowed
  | DbError
  | SimulatedFailure
  | Schema.SchemaError

// ---------------------------------------------------------------------------
// Sqlite: the database handle as a scoped resource (closed on dispose).
// ---------------------------------------------------------------------------
export const SCHEMA_VERSION = 2

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
          const version = db.pragma('user_version', { simple: true }) as number
          if (config.seed || version !== SCHEMA_VERSION) {
            seed(db, config.seedOptions)
            db.pragma(`user_version = ${SCHEMA_VERSION}`)
          }
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
    catch: (cause) => {
      if (cause instanceof BadQuery) return new BadRequest({ message: cause.message })
      if (cause instanceof DomainError) return cause.error
      const code = String((cause as { code?: string })?.code)
      const message = (cause as Error).message
      if (code === 'SQLITE_CONSTRAINT_TRIGGER') return new Conflict({ message }) // append-only tables etc.
      if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return new Conflict({ message })
      if (code.startsWith('SQLITE_CONSTRAINT')) return new BadRequest({ message })
      return new DbError({ cause })
    },
  })

/** Lets synchronous code inside a SQL transaction throw a typed error. */
export class DomainError extends Error {
  constructor(readonly error: NotFound | BadRequest | Forbidden | Conflict | MethodNotAllowed) {
    super(error.message)
  }
}

// ---------------------------------------------------------------------------
// Writer: SQLite has one writer and this process shares one connection. A
// write program runs inside BEGIN IMMEDIATE ... COMMIT/ROLLBACK and is executed
// *synchronously* (no await between BEGIN and COMMIT), so nothing else on the
// event loop - reads, logins, other writes - can ever observe or join an open
// transaction. Request bodies must therefore be read and decoded *before* the
// program is handed to the writer; an async step inside it fails loudly
// (AsyncFiberError -> 500) instead of holding the lock across I/O.
// ---------------------------------------------------------------------------
export class Writer extends Context.Service<
  Writer,
  {
    transaction: <A, E, R>(program: Effect.Effect<A, E, R>) => Effect.Effect<A, E | AppError, R>
    /** run synchronously under the write lock without a transaction (e.g. schema resets, which toggle pragmas) */
    exclusive: <A, E, R>(program: Effect.Effect<A, E, R>) => Effect.Effect<A, E | AppError, R>
  }
>()('app/Writer') {
  static layer = Layer.effect(
    Writer,
    Effect.gen(function* () {
      const db = yield* Sqlite
      const lock = yield* Semaphore.make(1)
      const runSync = <A, E, R>(program: Effect.Effect<A, E, R>, tx: boolean) =>
        lock.withPermits(1)(
          Effect.flatMap(Effect.context<R>(), (context) =>
            Effect.suspend((): Effect.Effect<A, E | AppError> => {
              if (tx) {
                try {
                  db.exec('BEGIN IMMEDIATE')
                } catch (cause) {
                  return Effect.fail(new DbError({ cause }))
                }
              }
              const exit = Effect.runSyncExitWith(context)(program)
              if (tx) {
                try {
                  db.exec(exit._tag === 'Success' ? 'COMMIT' : 'ROLLBACK')
                } catch (cause) {
                  if (db.inTransaction) db.exec('ROLLBACK')
                  return Effect.fail(new DbError({ cause }))
                }
              }
              return exit
            }),
          ),
        )
      return Writer.of({
        transaction: (program) => runSync(program, true),
        exclusive: (program) => runSync(program, false),
      })
    }),
  )
}

// ---------------------------------------------------------------------------
// Request-scoped services: who is calling, and a request id for the audit log.
// ---------------------------------------------------------------------------
export interface Principal extends Me {
  can: (p: Permission) => boolean
  /** owners/admins bypass row-level ownership rules */
  privileged: boolean
}

export class CurrentUser extends Context.Service<CurrentUser, Principal>()('app/CurrentUser') {}
export class RequestId extends Context.Service<RequestId, string>()('app/RequestId') {}

/** Fail with 403 (and record the denial in the audit log) unless the caller has `permission`. */
export const requirePermission = (permission: Permission) =>
  Effect.gen(function* () {
    const me = yield* CurrentUser
    if (!me.can(permission)) return yield* new Forbidden({ message: `Missing permission ${permission}` })
    return me
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
export type ChangeMessage =
  | { kind: 'upsert'; entity: string; row: { id: number | string } & Record<string, unknown> }
  | { kind: 'delete'; entity: string; id: number | string }
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
