// Effect Schema definitions shared by the server (request validation) and the
// client (form validation). One source of truth for what a valid write is.
import { Schema, SchemaTransformation } from 'effect'
import {
  PAYMENT_METHODS,
  PRODUCT_KINDS,
  SUBSCRIPTION_STATUSES,
  USAGE_METRICS,
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

/** Invoices are immutable except for voiding and moving the due date; "paid" is reached by recording payments. */
export const InvoicePatch = Schema.Struct({
  status: Schema.optionalKey(Schema.Literals(INVOICE_STATUSES)),
  dueAt: Schema.optionalKey(IsoDate),
})

export const ProjectPatch = Schema.Struct({
  name: Schema.optionalKey(Name),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  status: Schema.optionalKey(Schema.Literals(PROJECT_STATUSES)),
  ownerId: Schema.optionalKey(Schema.NullOr(Id)),
  teamId: Schema.optionalKey(Schema.NullOr(Id)),
  budgetHours: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }))),
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

export const LoginInput = Schema.Struct({ email: Schema.String, password: Schema.String })

export const TeamInput = Schema.Struct({
  id: Schema.optionalKey(Id),
  name: Name,
  description: Schema.String.check(Schema.isMaxLength(500)),
  leadId: Schema.NullOr(Id),
})
export const TeamPatch = Schema.Struct({
  name: Schema.optionalKey(Name),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  leadId: Schema.optionalKey(Schema.NullOr(Id)),
})
export const TeamMemberInput = Schema.Struct({ teamId: Id, userId: Id })

export const ContactInput = Schema.Struct({
  id: Schema.optionalKey(Id),
  customerId: Id,
  name: Name,
  email: Email,
  title: Schema.String.check(Schema.isMaxLength(120)),
  isPrimary: Schema.Boolean,
})
export const ContactPatch = Schema.Struct({
  name: Schema.optionalKey(Name),
  email: Schema.optionalKey(Email),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
  isPrimary: Schema.optionalKey(Schema.Boolean),
})

const Color = Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/i, { message: 'Expected a hex colour' }))
export const TagInput = Schema.Struct({ id: Schema.optionalKey(Id), name: Name, color: Color })
export const TagPatch = Schema.Struct({ name: Schema.optionalKey(Name), color: Schema.optionalKey(Color) })
export const CustomerTagInput = Schema.Struct({ customerId: Id, tagId: Id })

const Cents = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000_000 }))
export const ProductInput = Schema.Struct({
  id: Schema.optionalKey(Id),
  sku: Schema.String.check(Schema.isPattern(/^[A-Z0-9-]{3,32}$/, { message: 'SKU must be 3–32 chars of A–Z, 0–9 or -' })),
  name: Name,
  kind: Schema.Literals(PRODUCT_KINDS),
  planCode: Schema.NullOr(Schema.Literals(PLANS)),
  unitPrice: Cents,
  active: Schema.Boolean,
})
export const ProductPatch = Schema.Struct({
  name: Schema.optionalKey(Name),
  unitPrice: Schema.optionalKey(Cents),
  active: Schema.optionalKey(Schema.Boolean),
})

export const SubscriptionInput = Schema.Struct({
  id: Schema.optionalKey(Id),
  customerId: Id,
  productId: Id,
  quantity: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
  status: Schema.optionalKey(Schema.Literals(SUBSCRIPTION_STATUSES)),
})
export const SubscriptionPatch = Schema.Struct({
  quantity: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 }))),
  status: Schema.optionalKey(Schema.Literals(SUBSCRIPTION_STATUSES)),
})

export const PaymentInput = Schema.Struct({
  id: Schema.optionalKey(Id),
  invoiceId: Id,
  /** defaults to the outstanding remainder of the invoice */
  amount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  method: Schema.Literals(PAYMENT_METHODS),
  reference: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
})

export const ProjectInput = Schema.Struct({
  id: Schema.optionalKey(Id),
  name: Name,
  description: Schema.String.check(Schema.isMaxLength(2000)),
  customerId: Schema.NullOr(Id),
  ownerId: Schema.NullOr(Id),
  teamId: Schema.NullOr(Id),
  status: Schema.Literals(PROJECT_STATUSES),
  budgetHours: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100_000 })),
})

export const CommentInput = Schema.Struct({
  id: Schema.optionalKey(Id),
  taskId: Id,
  body: Schema.Trimmed.check(Schema.isMinLength(1, { message: 'Comment cannot be empty' }), Schema.isMaxLength(5000)),
})

const Minutes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 1440 }, { message: 'Minutes must be between 1 and 1440' }),
)
const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/, { message: 'Expected YYYY-MM-DD' }))
export const TimeEntryInput = Schema.Struct({
  id: Schema.optionalKey(Id),
  taskId: Id,
  minutes: Minutes,
  spentOn: Day,
  billable: Schema.Boolean,
  note: Schema.String.check(Schema.isMaxLength(500)),
})
export const TimeEntryPatch = Schema.Struct({
  minutes: Schema.optionalKey(Minutes),
  spentOn: Schema.optionalKey(Day),
  billable: Schema.optionalKey(Schema.Boolean),
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
})

export const UsageEventInput = Schema.Struct({
  customerId: Id,
  metric: Schema.Literals(USAGE_METRICS),
  quantity: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 })),
  occurredAt: IsoDate,
  /** replaying the same key is a no-op (exactly-once ingestion) */
  idempotencyKey: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
})

export const NotificationPatch = Schema.Struct({ readAt: Schema.NullOr(IsoDate) })

/** Atomic multi-entity write: all ops commit in one SQLite transaction or none do. */
export const BatchRequest = Schema.Struct({
  ops: Schema.Array(
    Schema.Struct({
      entity: Schema.String,
      op: Schema.Literals(['insert', 'update', 'delete']),
      id: Schema.optionalKey(Schema.Union([Id, Schema.String])),
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
