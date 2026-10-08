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

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const EVENT_TYPES = [
  'customer.created',
  'customer.updated',
  'customer.deleted',
  'invoice.paid',
  'invoice.created',
  'task.created',
  'task.updated',
  'task.deleted',
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
  createdAt: string
  updatedAt: string
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
  status: ProjectStatus
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
