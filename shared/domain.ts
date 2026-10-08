// Shared domain types + constants used by both the server and the client.

export const PLANS = ['free', 'starter', 'pro', 'enterprise'] as const
export type Plan = (typeof PLANS)[number]

export const CUSTOMER_STATUSES = ['active', 'trial', 'churned'] as const
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number]

export const INVOICE_STATUSES = ['paid', 'open', 'overdue', 'void'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

export const PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'completed'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export const TASK_STATUSES = ['todo', 'in_progress', 'review', 'done'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const
export type TaskPriority = (typeof TASK_PRIORITIES)[number]

export const ROLES = ['owner', 'admin', 'billing', 'member', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const EVENT_TYPES = [
  'customer.created',
  'customer.updated',
  'customer.deleted',
  'invoice.paid',
  'invoice.created',
  'invoice.voided',
  'payment.recorded',
  'subscription.changed',
  'task.created',
  'task.updated',
  'task.deleted',
  'comment.created',
  'user.updated',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const COUNTRIES = ['US', 'GB', 'DE', 'FR', 'CA', 'AU', 'NL', 'SE', 'JP', 'BR', 'IN', 'ES'] as const
export type Country = (typeof COUNTRIES)[number]

/** Monthly list price per seat in cents. */
export const PLAN_PRICE: Record<Plan, number> = {
  free: 0,
  starter: 1900,
  pro: 4900,
  enterprise: 12900,
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

export const PERMISSIONS = {
  'customers:read': 'View customers, contacts and tags',
  'customers:write': 'Create and edit customers (members: only accounts they own)',
  'customers:delete': 'Archive customers',
  'billing:read': 'View subscriptions, invoices, payments and balances',
  'billing:write': 'Change subscriptions, void invoices, record payments, run billing jobs (overdue, MRR rollup)',
  'products:read': 'View the product catalog',
  'products:write': 'Edit the product catalog',
  'projects:read': 'View projects, tasks, comments and time',
  'projects:write': 'Create/edit projects and tasks (members: projects of their teams)',
  'comments:write': 'Comment on tasks',
  'time:write': 'Log time (own entries only)',
  'usage:read': 'View metered usage',
  'usage:write': 'Ingest usage events',
  'team:read': 'View teammates and teams',
  'team:manage': 'Change roles, teams and memberships',
  'audit:read': 'Read the audit log',
  'admin:dev': 'Developer tools (chaos, reset; demo mode only)',
} as const
export type Permission = keyof typeof PERMISSIONS

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: Object.keys(PERMISSIONS) as Permission[],
  admin: (Object.keys(PERMISSIONS) as Permission[]).filter((p) => p !== 'admin:dev'),
  billing: [
    'customers:read',
    'billing:read',
    'billing:write',
    'products:read',
    'products:write',
    'usage:read',
    'projects:read',
    'team:read',
  ],
  member: [
    'customers:read',
    'customers:write',
    'billing:read',
    'products:read',
    'projects:read',
    'projects:write',
    'comments:write',
    'time:write',
    'usage:read',
    'team:read',
  ],
  viewer: ['customers:read', 'billing:read', 'products:read', 'projects:read', 'usage:read', 'team:read'],
}

export interface RoleRow {
  id: Role
  name: string
  description: string
  rank: number
}

export interface Me {
  user: User
  permissions: Permission[]
  teamIds: number[]
}

export interface User {
  id: number
  name: string
  email: string
  role: Role
  title: string
  avatarColor: string
  active: boolean
  createdAt: string
}

export interface Customer {
  id: number
  name: string
  email: string
  company: string
  plan: Plan
  status: CustomerStatus
  country: Country
  seats: number
  /** Monthly recurring revenue in cents. */
  mrr: number
  ownerId: number | null
  teamId: number | null
  createdAt: string
  updatedAt: string
}

export interface Team {
  id: number
  name: string
  description: string
  leadId: number | null
  createdAt: string
}

export interface TeamMember {
  /** `${teamId}:${userId}` */
  id: string
  teamId: number
  userId: number
  joinedAt: string
}

export interface Contact {
  id: number
  customerId: number
  name: string
  email: string
  title: string
  isPrimary: boolean
  createdAt: string
}

export interface Tag {
  id: number
  name: string
  color: string
}

export interface CustomerTag {
  /** `${customerId}:${tagId}` */
  id: string
  customerId: number
  tagId: number
  taggedAt: string
}

export const PRODUCT_KINDS = ['plan', 'addon'] as const
export interface Product {
  id: number
  sku: string
  name: string
  kind: (typeof PRODUCT_KINDS)[number]
  planCode: Plan | null
  unitPrice: number
  active: boolean
  createdAt: string
}

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'canceled'] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]
export interface Subscription {
  id: number
  customerId: number
  productId: number
  quantity: number
  unitPrice: number
  status: SubscriptionStatus
  startedAt: string
  canceledAt: string | null
}

export interface InvoiceLineItem {
  id: number
  invoiceId: number
  productId: number | null
  description: string
  quantity: number
  unitAmount: number
  amount: number
}

export const PAYMENT_METHODS = ['card', 'ach', 'wire'] as const
export interface Payment {
  id: number
  invoiceId: number
  customerId: number
  amount: number
  method: (typeof PAYMENT_METHODS)[number]
  reference: string
  receivedAt: string
  recordedBy: number | null
}

export interface CustomerBalance {
  /** = customerId */
  id: number
  customerId: number
  invoiced: number
  paid: number
  outstanding: number
  overdue: number
  updatedAt: string
}

export interface MrrSnapshot {
  /** YYYY-MM */
  id: string
  month: string
  mrr: number
  activeCustomers: number
  newCustomers: number
  churnedCustomers: number
  newMrr: number
  churnedMrr: number
  computedAt: string
}

export interface TaskComment {
  id: number
  taskId: number
  authorId: number | null
  body: string
  createdAt: string
}

export interface TimeEntry {
  id: number
  taskId: number
  userId: number
  minutes: number
  spentOn: string
  billable: boolean
  note: string
  createdAt: string
}

export const USAGE_METRICS = ['api_calls', 'storage_gb', 'active_seats'] as const
export type UsageMetric = (typeof USAGE_METRICS)[number]
export interface UsageEvent {
  id: number
  customerId: number
  metric: UsageMetric
  quantity: number
  occurredAt: string
}

export interface UsageDaily {
  /** `${customerId}:${metric}:${day}` */
  id: string
  customerId: number
  metric: UsageMetric
  day: string
  quantity: number
  events: number
}

export const AUDIT_ACTIONS = ['create', 'update', 'delete', 'login', 'logout', 'denied'] as const
export interface AuditEntry {
  id: number
  at: string
  actorId: number | null
  action: (typeof AUDIT_ACTIONS)[number]
  entity: string
  entityId: number | null
  /** JSON: { field: [before, after] } */
  changes: string
  requestId: string | null
}

export interface Notification {
  id: number
  userId: number
  kind: string
  title: string
  body: string
  entity: string | null
  entityId: number | null
  createdAt: string
  readAt: string | null
}

export interface ProjectStats {
  /** = projectId */
  id: number
  projectId: number
  taskCount: number
  doneCount: number
  minutesLogged: number
  billableMinutes: number
}

export const HEALTH = ['healthy', 'at_risk', 'dormant', 'churned'] as const
export interface CustomerHealth {
  /** = customerId */
  id: number
  customerId: number
  mrr: number
  overdue: number
  apiCalls30d: number
  health: (typeof HEALTH)[number]
}

export interface Invoice {
  id: number
  number: string
  customerId: number
  /** Amount in cents. */
  amount: number
  status: InvoiceStatus
  issuedAt: string
  dueAt: string
  paidAt: string | null
}

export interface Project {
  id: number
  name: string
  description: string
  customerId: number | null
  ownerId: number | null
  teamId: number | null
  status: ProjectStatus
  budgetHours: number
  createdAt: string
}

export interface Task {
  id: number
  projectId: number
  title: string
  status: TaskStatus
  priority: TaskPriority
  assigneeId: number | null
  dueDate: string | null
  position: number
  createdAt: string
  updatedAt: string
}

export interface ActivityEvent {
  id: number
  type: EventType
  /** prefix of `type` (customer, invoice, task, …) */
  category: string
  actorId: number | null
  customerId: number | null
  message: string
  createdAt: string
}

export interface Page<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
  pageCount: number
}

/** A list page that also carries totals over every matching row (`?sum=mrr`), not just this page. */
export interface SummedPage<T, K extends string = string> extends Page<T> {
  sums: Record<K, number>
}

export interface CursorPage<T> {
  data: T[]
  nextCursor: number | null
}

export interface OverviewMetrics {
  mrr: number
  arr: number
  activeCustomers: number
  trialCustomers: number
  churnedCustomers: number
  totalCustomers: number
  outstanding: number
  overdueCount: number
  openTasks: number
  arpa: number
}

export interface RevenuePoint {
  month: string
  revenue: number
  invoices: number
}

export interface SignupPoint {
  month: string
  plan: Plan
  count: number
}

export interface BreakdownPoint {
  key: string
  customers: number
  mrr: number
}

export interface ApiError {
  error: string
  message: string
  details?: unknown
}
