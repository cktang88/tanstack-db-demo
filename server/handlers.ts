import { Context, Effect, Schema } from 'effect'
import { PLAN_PRICE, type Customer, type CustomerStatus, type Plan } from '../shared/domain.ts'
import {
  CustomerInput,
  CustomerPatch,
  InvoicePatch,
  PaymentInput,
  SubscriptionInput,
  SubscriptionPatch,
  UsageEventInput,
} from '../shared/schemas.ts'
import { deleteRow, diff, getRow, insertRow, listRows, updateRow } from './db/query.ts'
import type { ListParams } from './db/sql.ts'
import { resources, type Access } from './resources.ts'
import {
  BadRequest,
  Conflict,
  CurrentUser,
  Forbidden,
  MethodNotAllowed,
  NotFound,
  RequestId,
  Sqlite,
  sql,
  type ChangeMessage,
  type Principal,
} from './services.ts'

// ---------------------------------------------------------------------------
// Outbox: change messages produced by a write are buffered per request and
// published to the SSE feed only after the transaction commits.
// ---------------------------------------------------------------------------
export class Outbox extends Context.Service<Outbox, { messages: ChangeMessage[] }>()('app/Outbox') {}

const ctx = Effect.gen(function* () {
  return { db: yield* Sqlite, me: yield* CurrentUser, outbox: yield* Outbox, requestId: yield* RequestId }
})

export const resourceOf = (name: string) =>
  resources[name] ? Effect.succeed(resources[name]) : Effect.fail(new NotFound({ entity: 'resource', id: name }))

const checkAccess = (access: Access | undefined, what: string) =>
  Effect.gen(function* () {
    const me = yield* CurrentUser
    if (access === undefined) return yield* new MethodNotAllowed({ message: `${what} is not supported` })
    if (access !== 'signed-in' && !me.can(access)) return yield* new Forbidden({ message: `Missing permission ${access}` })
  })

const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input) as unknown as Effect.Effect<S['Type'], Schema.SchemaError>

/** Re-read a row and queue it for the change feed (or a delete if it no longer exists / left its scope). */
export const touch = (name: string, id: unknown) =>
  Effect.gen(function* () {
    const { db, outbox } = yield* ctx
    const r = resources[name]!
    // visibility scopes (soft delete) apply; per-user scopes are enforced by the stream instead
    const scope = r.ownerField ? undefined : r.scope?.({} as Principal)
    const row = yield* sql(() => getRow(db, r, id, scope))
    outbox.messages.push(
      row ? { kind: 'upsert', entity: name, row: row as never } : { kind: 'delete', entity: name, id: id as number },
    )
    return row
  })

export const audit = (action: string, entity: string, entityId: unknown, before?: object, after?: object) =>
  Effect.gen(function* () {
    const { db, me, requestId } = yield* ctx
    const changes =
      action === 'update' ? diff(before as never, after as never) : action === 'create' ? diff(undefined, after as never) : {}
    yield* sql(() =>
      db
        .prepare(
          `INSERT INTO audit_log (at, actor_id, action, entity, entity_id, changes, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          new Date().toISOString(),
          me.user.id,
          action,
          entity,
          typeof entityId === 'number' ? entityId : null,
          JSON.stringify(changes),
          requestId,
        ),
    )
  })

export const recordEvent = (type: string, customerId: number | null, message: string) =>
  Effect.gen(function* () {
    const { db, me } = yield* ctx
    const id = yield* sql(
      () =>
        (
          db
            .prepare(`INSERT INTO events (type, actor_id, customer_id, message, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`)
            .get(type, me.user.id, customerId, message, new Date().toISOString()) as { id: number }
        ).id,
    )
    yield* touch('events', id)
  })

export const notify = (
  userId: number | null | undefined,
  kind: string,
  title: string,
  body: string,
  entity: string,
  entityId: number,
) =>
  Effect.gen(function* () {
    const { db, me } = yield* ctx
    if (!userId || userId === me.user.id) return
    const id = yield* sql(
      () =>
        (
          db
            .prepare(
              `INSERT INTO notifications (user_id, kind, title, body, entity, entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            )
            .get(userId, kind, title, body, entity, entityId, new Date().toISOString()) as { id: number }
        ).id,
    )
    yield* touch('notifications', id)
  })

const deny = (reason: string | undefined) => (reason ? Effect.fail(new Forbidden({ message: reason })) : Effect.void)

// ---------------------------------------------------------------------------
// Generic handlers
// ---------------------------------------------------------------------------
export const list = (name: string, params: ListParams) =>
  Effect.gen(function* () {
    const r = yield* resourceOf(name)
    const { db, me } = yield* ctx
    if (r.read && !me.can(r.read)) return yield* new Forbidden({ message: `Missing permission ${r.read}` })
    return yield* sql(() => listRows(db, r, params, r.scope?.(me)))
  })

export const get = (name: string, id: unknown) =>
  Effect.gen(function* () {
    const r = yield* resourceOf(name)
    const { db, me } = yield* ctx
    if (r.read && !me.can(r.read)) return yield* new Forbidden({ message: `Missing permission ${r.read}` })
    const row = yield* sql(() => getRow(db, r, id, r.scope?.(me)))
    if (!row) return yield* new NotFound({ entity: name, id })
    return row
  })

export const create = (name: string, input: unknown) =>
  Effect.gen(function* () {
    const r = yield* resourceOf(name)
    if (r.mode === 'read-only') return yield* new MethodNotAllowed({ message: `${name} is read-only` })
    yield* checkAccess(r.create, `Creating ${name}`)
    const custom = business[name]?.create
    if (custom) return yield* custom(input)
    if (!r.createSchema) return yield* new MethodNotAllowed({ message: `Creating ${name} is not supported` })
    const { db, me } = yield* ctx
    const decoded = (yield* decode(r.createSchema, input)) as Record<string, unknown>
    const data: Record<string, unknown> = { ...r.defaults?.(me), ...decoded, ...r.forced?.(me) }
    yield* deny(r.canWrite?.(me, data, db, 'create'))
    const id = yield* sql(() => insertRow(db, r, data))
    const row = yield* touch(name, id)
    yield* audit('create', name, id, undefined, row)
    yield* business[name]?.afterCreate?.(row!) ?? Effect.void
    return row!
  })

export const update = (name: string, id: unknown, input: unknown) =>
  Effect.gen(function* () {
    const r = yield* resourceOf(name)
    if (r.mode !== 'crud') return yield* new MethodNotAllowed({ message: `${name} is ${r.mode}` })
    yield* checkAccess(r.update, `Updating ${name}`)
    const { db, me } = yield* ctx
    const before = yield* sql(() => getRow(db, r, id, r.scope?.(me)))
    if (!before) return yield* new NotFound({ entity: name, id })
    const custom = business[name]?.update
    if (custom) return yield* custom(before, input)
    if (!r.patchSchema) return yield* new MethodNotAllowed({ message: `Updating ${name} is not supported` })
    const patch = (yield* decode(r.patchSchema, input)) as Record<string, unknown>
    yield* deny(r.canWrite?.(me, before, db, 'update'))
    yield* deny(r.canWrite?.(me, { ...before, ...patch }, db, 'update'))
    yield* sql(() => updateRow(db, r, id, patch))
    const after = yield* touch(name, id)
    yield* audit('update', name, id, before, after!)
    yield* business[name]?.afterUpdate?.(before, after!) ?? Effect.void
    return after!
  })

export const remove = (name: string, id: unknown) =>
  Effect.gen(function* () {
    const r = yield* resourceOf(name)
    if (r.mode !== 'crud') return yield* new MethodNotAllowed({ message: `${name} is ${r.mode}` })
    yield* checkAccess(r.remove, `Deleting ${name}`)
    const { db, me } = yield* ctx
    const before = yield* sql(() => getRow(db, r, id, r.scope?.(me)))
    if (!before) return yield* new NotFound({ entity: name, id })
    yield* deny(r.canWrite?.(me, before, db, 'delete'))
    const custom = business[name]?.remove
    if (custom) yield* custom(before)
    else yield* sql(() => deleteRow(db, r, id))
    yield* touch(name, id)
    yield* audit('delete', name, id, before)
    return null
  })

// ---------------------------------------------------------------------------
// Business logic
// ---------------------------------------------------------------------------
type Row = Record<string, any>
interface Business {
  create?: (input: unknown) => Effect.Effect<Row, any, any>
  update?: (before: Row, input: unknown) => Effect.Effect<Row, any, any>
  remove?: (before: Row) => Effect.Effect<void, any, any>
  afterCreate?: (row: Row) => Effect.Effect<void, any, any>
  afterUpdate?: (before: Row, after: Row) => Effect.Effect<void, any, any>
}

const SUB_STATUS: Record<CustomerStatus, string> = { active: 'active', trial: 'trialing', churned: 'canceled' }
const planProductId = (db: Sqlite['Service'], plan: Plan) =>
  (db.prepare(`SELECT id FROM products WHERE kind = 'plan' AND plan_code = ?`).get(plan) as { id: number }).id

/** The customer's current base-plan subscription, if any. */
const baseSubscription = (db: Sqlite['Service'], customerId: number) =>
  db
    .prepare(
      `SELECT s.id, s.product_id AS productId, s.quantity, s.status FROM subscriptions s JOIN products p ON p.id = s.product_id
       WHERE s.customer_id = ? AND p.kind = 'plan' AND s.status != 'canceled' ORDER BY s.id DESC LIMIT 1`,
    )
    .get(customerId) as { id: number; productId: number; quantity: number; status: string } | undefined

const touchSubscriptions = (customerId: number) =>
  Effect.gen(function* () {
    const { db } = yield* ctx
    const ids = yield* sql(() =>
      (db.prepare(`SELECT id FROM subscriptions WHERE customer_id = ?`).all(customerId) as Array<{ id: number }>).map(
        (r) => r.id,
      ),
    )
    for (const id of ids) yield* touch('subscriptions', id)
  })

/**
 * customers.plan / seats / status are a *projection* of the base-plan
 * subscription. Editing them on the customer is translated into subscription
 * changes; the MRR trigger then recomputes customers.mrr.
 */
const syncSubscriptions = (customer: Customer, next: { plan: Plan; seats: number; status: CustomerStatus }) =>
  Effect.gen(function* () {
    const { db } = yield* ctx
    const now = new Date().toISOString()
    const base = yield* sql(() => baseSubscription(db, customer.id))
    yield* sql(() => {
      if (next.status === 'churned') {
        db.prepare(
          `UPDATE subscriptions SET status = 'canceled', canceled_at = ? WHERE customer_id = ? AND status != 'canceled'`,
        ).run(now, customer.id)
        return
      }
      const status = SUB_STATUS[next.status]
      const productId = planProductId(db, next.plan)
      if (!base || base.productId !== productId) {
        // plan change (or reactivation): close the old base plan and start a new one at list price
        if (base) db.prepare(`UPDATE subscriptions SET status = 'canceled', canceled_at = ? WHERE id = ?`).run(now, base.id)
        db.prepare(
          `INSERT INTO subscriptions (customer_id, product_id, quantity, unit_price, status, started_at) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(customer.id, productId, next.seats, PLAN_PRICE[next.plan], status, now)
      } else {
        db.prepare(`UPDATE subscriptions SET quantity = ?, status = ? WHERE id = ?`).run(next.seats, status, base.id)
      }
      // add-ons follow the account's lifecycle
      db.prepare(
        `UPDATE subscriptions SET status = ? WHERE customer_id = ? AND status != 'canceled'
         AND product_id IN (SELECT id FROM products WHERE kind = 'addon')`,
      ).run(status, customer.id)
    })
    yield* touchSubscriptions(customer.id)
  })

const business: Record<string, Business> = {
  customers: {
    create: (input) =>
      Effect.gen(function* () {
        const { db, me } = yield* ctx
        const data = yield* decode(CustomerInput, input)
        // members can only create accounts they own
        const ownerId = me.privileged ? data.ownerId : me.user.id
        const teamId = ownerId
          ? ((yield* sql(
              () =>
                db.prepare(`SELECT MIN(team_id) AS t FROM team_members WHERE user_id = ?`).get(ownerId) as { t: number | null },
            )).t ?? null)
          : null
        const now = new Date().toISOString()
        const id = yield* sql(
          () =>
            (
              db
                .prepare(
                  `INSERT INTO customers (id, name, email, company, plan, status, country, seats, owner_id, team_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                )
                .get(
                  data.id ?? null,
                  data.name,
                  data.email,
                  data.company,
                  data.plan,
                  data.status,
                  data.country,
                  data.seats,
                  ownerId,
                  teamId,
                  now,
                  now,
                ) as {
                id: number
              }
            ).id,
        )
        yield* sql(() =>
          db
            .prepare(
              `INSERT INTO contacts (customer_id, name, email, title, is_primary, created_at) VALUES (?, ?, ?, 'Primary contact', 1, ?)`,
            )
            .run(id, data.name, data.email, now),
        )
        const created = (yield* sql(() => getRow<Customer>(db, resources.customers!, id)))!
        yield* syncSubscriptions(created, data)
        const row = yield* touch('customers', id)
        const contact = yield* sql(
          () => (db.prepare(`SELECT id FROM contacts WHERE customer_id = ?`).get(id) as { id: number }).id,
        )
        yield* touch('contacts', contact)
        yield* audit('create', 'customers', id, undefined, row!)
        yield* recordEvent('customer.created', id, `New customer ${data.company}`)
        return row!
      }),
    update: (before, input) =>
      Effect.gen(function* () {
        const { db, me } = yield* ctx
        const patch = yield* decode(CustomerPatch, input)
        const r = resources.customers!
        yield* deny(r.canWrite!(me, before, db, 'update'))
        if (patch.ownerId !== undefined && patch.ownerId !== before.ownerId && !me.privileged)
          return yield* new Forbidden({ message: 'Only admins can reassign account ownership' })
        const next = {
          plan: patch.plan ?? before.plan,
          seats: patch.seats ?? before.seats,
          status: patch.status ?? before.status,
        }
        yield* sql(() =>
          db
            .prepare(
              `UPDATE customers SET name = ?, email = ?, company = ?, country = ?, owner_id = ?, plan = ?, seats = ?, status = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              patch.name ?? before.name,
              patch.email ?? before.email,
              patch.company ?? before.company,
              patch.country ?? before.country,
              patch.ownerId !== undefined ? patch.ownerId : before.ownerId,
              next.plan,
              next.seats,
              next.status,
              new Date().toISOString(),
              before.id,
            ),
        )
        if (next.plan !== before.plan || next.seats !== before.seats || next.status !== before.status)
          yield* syncSubscriptions(before as Customer, next)
        const after = (yield* touch('customers', before.id))!
        yield* audit('update', 'customers', before.id, before, after)
        yield* recordEvent('customer.updated', before.id, `Updated ${after.company} (${Object.keys(patch).join(', ')})`)
        if (patch.ownerId && patch.ownerId !== before.ownerId)
          yield* notify(
            patch.ownerId,
            'assignment',
            'Account assigned to you',
            `${after.company} is now yours`,
            'customers',
            before.id,
          )
        return after
      }),
    remove: (before) =>
      Effect.gen(function* () {
        const { db } = yield* ctx
        // archiving cancels billing but keeps history (invoices, payments, audit)
        yield* sql(() => {
          const now = new Date().toISOString()
          db.prepare(`UPDATE customers SET deleted_at = ?, status = 'churned' WHERE id = ?`).run(now, before.id)
          db.prepare(
            `UPDATE subscriptions SET status = 'canceled', canceled_at = ? WHERE customer_id = ? AND status != 'canceled'`,
          ).run(now, before.id)
        })
        yield* touchSubscriptions(before.id)
        const invoices = yield* sql(() =>
          (db.prepare(`SELECT id FROM invoices WHERE customer_id = ?`).all(before.id) as Array<{ id: number }>).map((r) => r.id),
        )
        for (const id of invoices) yield* touch('invoices', id) // leave scope -> deletes on clients
        yield* recordEvent('customer.deleted', null, `Archived customer ${before.company}`)
      }),
  },

  subscriptions: {
    create: (input) =>
      Effect.gen(function* () {
        const { db } = yield* ctx
        const data = yield* decode(SubscriptionInput, input)
        const product = yield* sql(
          () =>
            db
              .prepare(`SELECT id, kind, plan_code AS planCode, unit_price AS unitPrice, active FROM products WHERE id = ?`)
              .get(data.productId) as
              | { id: number; kind: string; planCode: Plan | null; unitPrice: number; active: number }
              | undefined,
        )
        if (!product) return yield* new NotFound({ entity: 'products', id: data.productId })
        if (!product.active) return yield* new Conflict({ message: 'Product is not for sale' })
        const customer = yield* sql(() =>
          getRow<Customer>(db, resources.customers!, data.customerId, resources.customers!.scope!({} as never)),
        )
        if (!customer) return yield* new NotFound({ entity: 'customers', id: data.customerId })
        if (product.kind === 'plan')
          return yield* new Conflict({
            message: 'Change the base plan by editing the customer’s plan; subscriptions here are for add-ons',
          })
        const now = new Date().toISOString()
        const id = yield* sql(
          () =>
            (
              db
                .prepare(
                  `INSERT INTO subscriptions (id, customer_id, product_id, quantity, unit_price, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
                )
                .get(
                  data.id ?? null,
                  data.customerId,
                  data.productId,
                  data.quantity,
                  product.unitPrice,
                  data.status ?? 'active',
                  now,
                ) as { id: number }
            ).id,
        )
        const row = (yield* touch('subscriptions', id))!
        yield* touch('customers', data.customerId)
        yield* audit('create', 'subscriptions', id, undefined, row)
        yield* recordEvent('subscription.changed', data.customerId, `Added add-on to ${customer.company}`)
        return row
      }),
    update: (before, input) =>
      Effect.gen(function* () {
        const { db } = yield* ctx
        const patch = yield* decode(SubscriptionPatch, input)
        if (before.status === 'canceled') return yield* new Conflict({ message: 'Canceled subscriptions cannot be changed' })
        yield* sql(() =>
          db
            .prepare(`UPDATE subscriptions SET quantity = ?, status = ?, canceled_at = ? WHERE id = ?`)
            .run(
              patch.quantity ?? before.quantity,
              patch.status ?? before.status,
              (patch.status ?? before.status) === 'canceled' ? new Date().toISOString() : null,
              before.id,
            ),
        )
        const after = (yield* touch('subscriptions', before.id))!
        // keep the customer projection in sync when the base plan's seat count changes
        const isPlan = yield* sql(
          () => (db.prepare(`SELECT kind FROM products WHERE id = ?`).get(before.productId) as { kind: string }).kind === 'plan',
        )
        if (isPlan && patch.quantity)
          yield* sql(() => db.prepare(`UPDATE customers SET seats = ? WHERE id = ?`).run(patch.quantity, before.customerId))
        yield* touch('customers', before.customerId)
        yield* audit('update', 'subscriptions', before.id, before, after)
        yield* recordEvent('subscription.changed', before.customerId, `Subscription #${before.id} changed`)
        return after
      }),
  },

  invoices: {
    update: (before, input) =>
      Effect.gen(function* () {
        const { db } = yield* ctx
        const patch = yield* decode(InvoicePatch, input)
        if (patch.status === 'paid') {
          // convenience: "mark paid" = record a payment for the remainder
          yield* recordPayment({ invoiceId: before.id, method: 'card' })
          return (yield* touch('invoices', before.id))!
        }
        if (patch.status && patch.status !== before.status) {
          if (patch.status !== 'void')
            return yield* new Conflict({ message: `Invoices cannot be moved to "${patch.status}" manually` })
          if (before.status === 'paid')
            return yield* new Conflict({ message: 'Paid invoices cannot be voided; issue a credit instead' })
        }
        yield* sql(() =>
          db
            .prepare(`UPDATE invoices SET status = ?, due_at = ? WHERE id = ?`)
            .run(patch.status ?? before.status, patch.dueAt ?? before.dueAt, before.id),
        )
        const after = (yield* touch('invoices', before.id))!
        yield* touch('customer-balances', before.customerId)
        yield* audit('update', 'invoices', before.id, before, after)
        if (patch.status === 'void') yield* recordEvent('invoice.voided', before.customerId, `Invoice ${before.number} voided`)
        return after
      }),
  },

  payments: { create: (input) => Effect.flatMap(decode(PaymentInput, input), recordPayment) },

  'usage-events': {
    create: (input) =>
      Effect.gen(function* () {
        const { db } = yield* ctx
        const data = yield* decode(UsageEventInput, input)
        const r = resources['usage-events']!
        if (data.idempotencyKey) {
          const existing = yield* sql(
            () =>
              db.prepare(`SELECT id FROM usage_events WHERE idempotency_key = ?`).get(data.idempotencyKey) as
                | { id: number }
                | undefined,
          )
          if (existing) return (yield* sql(() => getRow(db, r, existing.id)))! // exactly-once: replay returns the original
        }
        const id = yield* sql(() => insertRow(db, r, data))
        const row = (yield* touch('usage-events', id))!
        yield* touch('usage-daily', `${data.customerId}:${data.metric}:${data.occurredAt.slice(0, 10)}`)
        return row
      }),
  },

  tasks: {
    afterCreate: (row) => notify(row.assigneeId, 'assignment', 'New task assigned', row.title, 'tasks', row.id),
    afterUpdate: (before, after) =>
      Effect.gen(function* () {
        if (after.assigneeId !== before.assigneeId)
          yield* notify(after.assigneeId, 'assignment', 'Task assigned to you', after.title, 'tasks', after.id)
        if (after.status !== before.status)
          yield* recordEvent('task.updated', null, `Moved task "${after.title}" to ${after.status}`)
        yield* touch('project-stats', after.projectId)
      }),
    remove: (before) =>
      Effect.gen(function* () {
        const { db } = yield* ctx
        const comments = yield* sql(
          () => (db.prepare(`SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?`).get(before.id) as { n: number }).n,
        )
        if (comments > 0)
          return yield* new Conflict({
            message: `Task has ${comments} comment(s) — the discussion is a permanent record; mark it done instead`,
          })
        yield* sql(() => db.prepare(`DELETE FROM tasks WHERE id = ?`).run(before.id))
        yield* touch('project-stats', before.projectId)
      }),
  },

  'task-comments': {
    afterCreate: (row) =>
      Effect.gen(function* () {
        const { db } = yield* ctx
        const task = yield* sql(
          () =>
            db.prepare(`SELECT title, assignee_id AS assigneeId FROM tasks WHERE id = ?`).get(row.taskId) as
              | { title: string; assigneeId: number | null }
              | undefined,
        )
        if (!task) return yield* new NotFound({ entity: 'tasks', id: row.taskId })
        yield* notify(
          task.assigneeId,
          'mention',
          'New comment on your task',
          `${task.title}: ${String(row.body).slice(0, 80)}`,
          'tasks',
          row.taskId,
        )
        yield* recordEvent('comment.created', null, `Commented on "${task.title}"`)
      }),
  },

  'time-entries': {
    afterCreate: (row) => touchProjectOfTask(row.taskId),
    afterUpdate: (_b, row) => touchProjectOfTask(row.taskId),
  },

  users: {
    afterUpdate: (before, after) =>
      before.role !== after.role
        ? notify(after.id, 'role', 'Your role changed', `You are now ${after.role}`, 'users', after.id)
        : Effect.void,
  },
}

const touchProjectOfTask = (taskId: number) =>
  Effect.gen(function* () {
    const { db } = yield* ctx
    const p = yield* sql(
      () => db.prepare(`SELECT project_id AS p FROM tasks WHERE id = ?`).get(taskId) as { p: number } | undefined,
    )
    if (p) yield* touch('project-stats', p.p)
  })

/** Append a payment to the ledger. The DB trigger settles the invoice when fully covered. */
export const recordPayment = (data: typeof PaymentInput.Type) =>
  Effect.gen(function* () {
    const { db, me } = yield* ctx
    if (!me.can('billing:write')) return yield* new Forbidden({ message: 'Missing permission billing:write' })
    const inv = yield* sql(() => getRow<Row>(db, resources.invoices!, data.invoiceId, resources.invoices!.scope!(me)))
    if (!inv) return yield* new NotFound({ entity: 'invoices', id: data.invoiceId })
    if (inv.status === 'void') return yield* new Conflict({ message: 'Cannot pay a void invoice' })
    const paid = yield* sql(
      () =>
        (db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE invoice_id = ?`).get(inv.id) as { s: number }).s,
    )
    const remaining = inv.amount - paid
    if (remaining <= 0) return yield* new Conflict({ message: 'Invoice is already fully paid' })
    const amount = data.amount ?? remaining
    if (amount > remaining) return yield* new BadRequest({ message: `Overpayment: only ${remaining} cents outstanding` })
    const id = yield* sql(
      () =>
        (
          db
            .prepare(
              `INSERT INTO payments (id, invoice_id, customer_id, amount, method, reference, received_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            )
            .get(
              data.id ?? null,
              inv.id,
              inv.customerId,
              amount,
              data.method,
              data.reference ?? `${data.method.toUpperCase()}-${inv.id}-${Date.now()}`,
              new Date().toISOString(),
              me.user.id,
            ) as {
            id: number
          }
        ).id,
    )
    const payment = (yield* touch('payments', id))!
    const invoice = (yield* touch('invoices', inv.id))!
    yield* touch('customer-balances', inv.customerId)
    yield* audit('create', 'payments', id, undefined, payment)
    yield* recordEvent(
      invoice.status === 'paid' ? 'invoice.paid' : 'payment.recorded',
      inv.customerId,
      invoice.status === 'paid' ? `Invoice ${inv.number} marked paid` : `Partial payment on ${inv.number}`,
    )
    return payment
  })
