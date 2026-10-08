import { CUSTOMER_STATUSES, INVOICE_STATUSES, PLANS, COUNTRIES } from '../../shared/domain'
import type { SearchSchemaInput } from '@tanstack/react-router'

export interface CustomerListParams {
  page: number
  pageSize: number
  sort?: string
  q?: string
  status?: string[]
  plan?: string[]
  country?: string[]
  ownerId?: number
}

export interface InvoiceListParams {
  page: number
  pageSize: number
  sort?: string
  q?: string
  status?: string[]
  customerId?: number
  issuedFrom?: string
  issuedTo?: string
}

type Input<T> = { [K in keyof T]?: unknown } & SearchSchemaInput

// URL search-param validators for table pages: every bit of table state
// (page, page size, sort, filters) lives in the URL so it is shareable.

const int = (v: unknown, def: number, min = 1, max = 500) => {
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : def
}
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)
const list = <T extends string>(v: unknown, allowed: readonly T[]): T[] | undefined => {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []
  const out = arr.filter((x): x is T => allowed.includes(x as T))
  return out.length ? out : undefined
}
// one or more sort fields (shift-click multi-sort): "-createdAt,company"
const sortRe = /^-?[a-zA-Z]+(?:,-?[a-zA-Z]+)*$/

export const PAGE_SIZES = [10, 25, 50, 100] as const

export function customersSearch(s: Input<CustomerListParams>): CustomerListParams {
  return {
    page: int(s.page, 1, 1, 100_000),
    pageSize: int(s.pageSize, 25, 5, 100),
    sort: typeof s.sort === 'string' && sortRe.test(s.sort) ? s.sort : '-createdAt',
    q: str(s.q),
    status: list(s.status, CUSTOMER_STATUSES),
    plan: list(s.plan, PLANS),
    country: list(s.country, COUNTRIES),
    ownerId: s.ownerId !== undefined ? int(s.ownerId, 0, 1, 1_000_000) || undefined : undefined,
  }
}

export function invoicesSearch(s: Input<InvoiceListParams>): InvoiceListParams {
  const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)
  return {
    page: int(s.page, 1, 1, 100_000),
    pageSize: int(s.pageSize, 25, 5, 100),
    sort: typeof s.sort === 'string' && sortRe.test(s.sort) ? s.sort : '-issuedAt',
    q: str(s.q),
    status: list(s.status, INVOICE_STATUSES),
    customerId: s.customerId !== undefined ? int(s.customerId, 0, 1, 1_000_000) || undefined : undefined,
    issuedFrom: date(s.issuedFrom),
    issuedTo: date(s.issuedTo),
  }
}

/** "-mrr" <-> [{ id: 'mrr', desc: true }] */
export function parseSort(sort: string | undefined) {
  if (!sort) return []
  return sort.split(',').map((s) => (s.startsWith('-') ? { id: s.slice(1), desc: true } : { id: s, desc: false }))
}
export function formatSort(sorting: Array<{ id: string; desc: boolean }>) {
  return sorting.map((s) => (s.desc ? `-${s.id}` : s.id)).join(',') || undefined
}

export interface AuditParams {
  page: number
  pageSize: number
  action?: string
  entity?: string
  actorId?: number
}
export function auditSearch(s: Input<AuditParams>): AuditParams {
  return {
    page: int(s.page, 1, 1, 100_000),
    pageSize: int(s.pageSize, 50, 5, 200),
    action: str(s.action),
    entity: str(s.entity),
    actorId: s.actorId !== undefined ? int(s.actorId, 0, 1, 1_000_000) || undefined : undefined,
  }
}
