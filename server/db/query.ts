import type { Page } from '../../shared/domain.ts'
import type { Resource, ScopeSql } from '../resources.ts'
import type { DB } from './schema.ts'
import { BadQuery, buildOrderBy, buildWhere, lookup, type ListParams } from './sql.ts'

// Generic, whitelist-driven SQL for any registered resource.

export const selectSql = (r: Resource) =>
  Object.entries(r.columns)
    .map(([k, c]) => `${c.sql} AS "${k}"`)
    .join(', ')

const boolFields = (r: Resource) =>
  Object.entries(r.columns)
    .filter(([, c]) => c.type === 'bool')
    .map(([k]) => k)

export function mapRow<T = Record<string, unknown>>(r: Resource, row: any): T {
  if (!row) return row
  for (const f of boolFields(r)) if (f in row) row[f] = !!row[f]
  return row as T
}

const andScope = (where: { sql: string; params: unknown[] }, scope: ScopeSql | undefined) => {
  if (!scope) return where
  return where.sql
    ? { sql: `${where.sql} AND (${scope.sql})`, params: [...where.params, ...scope.params] }
    : { sql: `WHERE ${scope.sql}`, params: scope.params }
}

/** `?sum=` fields -> their (whitelisted, numeric) column SQL */
const sumColumns = (r: Resource, fields: string[]) =>
  fields.map((f) => {
    const col = r.summable?.includes(f) ? lookup(r.columns, f) : undefined
    if (!col || col.type !== 'number') throw new BadQuery(`Cannot sum "${f}"`)
    return [f, col.sql] as const
  })

export function listRows<T>(db: DB, r: Resource, p: ListParams, scope?: ScopeSql): Page<T> & { sums?: Record<string, number> } {
  const where = andScope(
    buildWhere(r.columns, p.filters, { term: p.search, fields: r.search ?? [], fullText: r.fullText }, r.virtual),
    scope,
  )
  const sorts = p.sorts.length
    ? p.sorts
    : r.defaultSort
      ? [{ field: r.defaultSort.replace(/^-/, ''), dir: r.defaultSort.startsWith('-') ? ('desc' as const) : ('asc' as const) }]
      : []
  const order = buildOrderBy(r.columns, sorts, 'id', r.virtual)
  const sums = sumColumns(r, [...new Set(p.sums ?? [])])
  // the count and any totals are aggregates over every matching row, not just this page
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS n${sums.map(([, sql], i) => `, COALESCE(SUM(${sql}), 0) AS s${i}`).join('')} FROM ${r.table} ${where.sql}`,
    )
    .get(...where.params) as Record<string, number>
  const total = agg.n!
  const limit = p.limit !== undefined ? `LIMIT ${Math.max(0, Math.floor(p.limit))}` : ''
  const offset = p.offset ? `OFFSET ${Math.max(0, Math.floor(p.offset))}` : ''
  const rows = db
    .prepare(`SELECT ${selectSql(r)} FROM ${r.table} ${where.sql} ${order} ${limit || (offset ? 'LIMIT -1' : '')} ${offset}`)
    .all(...where.params)
    .map((row) => mapRow<T>(r, row))
  const pageSize = p.limit ?? total
  return {
    data: rows,
    total,
    page: pageSize ? Math.floor((p.offset ?? 0) / pageSize) + 1 : 1,
    pageSize,
    pageCount: pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1,
    ...(sums.length && { sums: Object.fromEntries(sums.map(([f], i) => [f, agg[`s${i}`]!])) }),
  }
}

export function getRow<T = Record<string, any>>(db: DB, r: Resource, id: unknown, scope?: ScopeSql): T | undefined {
  const s = scope ? ` AND (${scope.sql})` : ''
  const row = db.prepare(`SELECT ${selectSql(r)} FROM ${r.table} WHERE ${r.key} = ?${s}`).get(id, ...(scope?.params ?? []))
  return row ? mapRow<T>(r, row) : undefined
}

const toSqlValue = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)

/** Insert using the resource's writable map; returns the new row's key. */
export function insertRow(db: DB, r: Resource, data: Record<string, unknown>) {
  const entries = Object.entries(data).filter(
    ([k, v]) => v !== undefined && r.writable !== undefined && Object.hasOwn(r.writable, k),
  )
  const cols = entries.map(([k]) => r.writable![k]!)
  const res = db
    .prepare(`INSERT INTO ${r.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING ${r.key} AS k`)
    .get(...entries.map(([, v]) => toSqlValue(v))) as { k: unknown }
  return res.k
}

export function updateRow(db: DB, r: Resource, id: unknown, patch: Record<string, unknown>) {
  const entries = Object.entries(patch).filter(
    ([k, v]) => v !== undefined && r.writable !== undefined && Object.hasOwn(r.writable, k),
  )
  if (!entries.length) return 0
  return db
    .prepare(`UPDATE ${r.table} SET ${entries.map(([k]) => `${r.writable![k]} = ?`).join(', ')} WHERE ${r.key} = ?`)
    .run(...entries.map(([, v]) => toSqlValue(v)), id).changes
}

export function deleteRow(db: DB, r: Resource, id: unknown) {
  if (r.softDelete)
    return db.prepare(`UPDATE ${r.table} SET ${r.softDelete} = ? WHERE ${r.key} = ?`).run(new Date().toISOString(), id).changes
  return db.prepare(`DELETE FROM ${r.table} WHERE ${r.key} = ?`).run(id).changes
}

/** Field-level diff for the audit log: { field: [before, after] } */
export function diff(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) {
  const out: Record<string, [unknown, unknown]> = {}
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  for (const k of keys) {
    const a = before?.[k]
    const b = after?.[k]
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = [a ?? null, b ?? null]
  }
  return out
}
