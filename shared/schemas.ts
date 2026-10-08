// Effect Schema definitions shared by the server (request validation) and the
// client (form validation). One source of truth for what a valid write is.
import { Schema, SchemaTransformation } from 'effect'
import {
  COUNTRIES,
  CUSTOMER_STATUSES,
  INVOICE_STATUSES,
  PLANS,
  PROJECT_STATUSES,
  ROLES,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from './domain.ts'

const Id = Schema.Int.check(Schema.isGreaterThan(0))
const Email = Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, { message: 'Enter a valid email address' }))
const Name = Schema.Trimmed.check(Schema.isMinLength(2, { message: 'Must be at least 2 characters' }), Schema.isMaxLength(120))
const IsoDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}/, { message: 'Expected an ISO date' }))

export const CustomerInput = Schema.Struct({
  /** Optional client-generated id (lets optimistic clients avoid temp-id swaps). */
  id: Schema.optionalKey(Id),
  name: Name,
  email: Email,
  company: Name,
  plan: Schema.Literals(PLANS),
  status: Schema.Literals(CUSTOMER_STATUSES),
  country: Schema.Literals(COUNTRIES),
  seats: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }, { message: 'Seats must be between 1 and 10,000' })),
  ownerId: Schema.NullOr(Id),
})
export type CustomerInput = typeof CustomerInput.Type

export const CustomerPatch = Schema.Struct({
  name: Schema.optionalKey(Name),
  email: Schema.optionalKey(Email),
  company: Schema.optionalKey(Name),
  plan: Schema.optionalKey(Schema.Literals(PLANS)),
  status: Schema.optionalKey(Schema.Literals(CUSTOMER_STATUSES)),
  country: Schema.optionalKey(Schema.Literals(COUNTRIES)),
  seats: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
  ownerId: Schema.optionalKey(Schema.NullOr(Id)),
})
export type CustomerPatch = typeof CustomerPatch.Type

export const InvoicePatch = Schema.Struct({
  status: Schema.optionalKey(Schema.Literals(INVOICE_STATUSES)),
  paidAt: Schema.optionalKey(Schema.NullOr(IsoDate)),
})

export const ProjectPatch = Schema.Struct({
  name: Schema.optionalKey(Name),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  status: Schema.optionalKey(Schema.Literals(PROJECT_STATUSES)),
  ownerId: Schema.optionalKey(Schema.NullOr(Id)),
})

export const TaskInput = Schema.Struct({
  id: Schema.optionalKey(Id),
  projectId: Id,
  title: Schema.Trimmed.check(Schema.isMinLength(3, { message: 'Title must be at least 3 characters' }), Schema.isMaxLength(200)),
  status: Schema.Literals(TASK_STATUSES),
  priority: Schema.Literals(TASK_PRIORITIES),
  assigneeId: Schema.NullOr(Id),
  dueDate: Schema.NullOr(IsoDate),
  position: Schema.optionalKey(Schema.Finite),
})

export const TaskPatch = Schema.Struct({
  projectId: Schema.optionalKey(Id),
  title: Schema.optionalKey(Schema.Trimmed.check(Schema.isMinLength(3), Schema.isMaxLength(200))),
  status: Schema.optionalKey(Schema.Literals(TASK_STATUSES)),
  priority: Schema.optionalKey(Schema.Literals(TASK_PRIORITIES)),
  assigneeId: Schema.optionalKey(Schema.NullOr(Id)),
  dueDate: Schema.optionalKey(Schema.NullOr(IsoDate)),
  position: Schema.optionalKey(Schema.Finite),
})

export const UserPatch = Schema.Struct({
  name: Schema.optionalKey(Name),
  title: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.Literals(ROLES)),
  active: Schema.optionalKey(Schema.Boolean),
})

export const BATCH_ENTITIES = ['customers', 'invoices', 'projects', 'tasks', 'users'] as const
export type BatchEntity = (typeof BATCH_ENTITIES)[number]

/** Atomic multi-entity write: all ops commit in one SQLite transaction or none do. */
export const BatchRequest = Schema.Struct({
  ops: Schema.Array(
    Schema.Struct({
      entity: Schema.Literals(BATCH_ENTITIES),
      op: Schema.Literals(['insert', 'update', 'delete']),
      id: Schema.optionalKey(Id),
      data: Schema.optionalKey(Schema.Unknown),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
})
export type BatchOp = (typeof BatchRequest.Type)['ops'][number]

export const ChaosConfig = Schema.Struct({
  latencyMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  failRate: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
})
export type ChaosConfig = typeof ChaosConfig.Type

/** HTML form -> CustomerInput (strings to numbers / nulls). */
export const CustomerForm = Schema.Struct({
  name: Name,
  email: Email,
  company: Name,
  plan: Schema.Literals(PLANS),
  status: Schema.Literals(CUSTOMER_STATUSES),
  country: Schema.Literals(COUNTRIES),
  seats: Schema.FiniteFromString.check(
    Schema.isInt({ message: 'Seats must be a whole number' }),
    Schema.isBetween({ minimum: 1, maximum: 10_000 }, { message: 'Seats must be between 1 and 10,000' }),
  ),
  ownerId: Schema.String.pipe(
    Schema.decodeTo(
      Schema.NullOr(Schema.Finite),
      SchemaTransformation.transform({
        decode: (s: string) => (s === '' ? null : Number(s)),
        encode: (n: number | null) => (n === null ? '' : String(n)),
      }),
    ),
  ),
})
