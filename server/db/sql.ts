// Tiny, safe SQL helpers for building filtered / sorted / paginated list queries
// from a whitelist of columns. Every identifier comes from a whitelist, every value
// is a bound parameter.

export interface ColumnDef {
  /** SQL expression, e.g. `c.created_at` */
  sql: string
  type: 'text' | 'number' | 'bool'
}

export type Columns = Record<string, ColumnDef>

export type FilterOp = 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'isNull' | 'notNull'

export interface Filter {
  field: string
  op: FilterOp
  value?: unknown
}

export interface Sort {
  field: string
  dir: 'asc' | 'desc'
}

export interface ListParams {
  filters: Filter[]
  sorts: Sort[]
  search?: string
  limit?: number
  offset?: number
  /** numeric fields to total over every matching row (`?sum=mrr,seats`) */
  sums?: string[]
}

export class BadQuery extends Error {}

/** Own-property lookup: query keys like `constructor` or `__proto__` must not resolve to Object.prototype members. */
export const lookup = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined

const coerce = (col: ColumnDef, v: unknown) => {
  if (col.type === 'number') {
    const n = Number(v)
    if (!Number.isFinite(n)) throw new BadQuery(`Expected number, got ${String(v)}`)
    return n
  }
  if (col.type === 'bool') return v === true || v === 'true' || v === 1 || v === '1' ? 1 : 0
  return String(v)
}

/**
 * `virtual` holds extra whitelisted expressions (e.g. a related row's name via a
 * scalar subquery) that may be searched but not filtered on.
 */
export function buildWhere(
  columns: Columns,
  filters: Filter[],
  search?: { term?: string; fields: string[] },
  virtual: Columns = {},
) {
  const clauses: string[] = []
  const params: unknown[] = []
  for (const f of filters) {
    const col = lookup(columns, f.field)
    if (!col) throw new BadQuery(`Unknown filter field "${f.field}"`)
    switch (f.op) {
      case 'eq':
      case 'neq':
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const op = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }[f.op]
        clauses.push(`${col.sql} ${op} ?`)
        params.push(coerce(col, f.value))
        break
      }
      case 'in': {
        const values = (Array.isArray(f.value) ? f.value : String(f.value).split(',')).filter((v) => v !== '')
        if (values.length === 0) {
          clauses.push('0')
          break
        }
        clauses.push(`${col.sql} IN (${values.map(() => '?').join(',')})`)
        params.push(...values.map((v) => coerce(col, v)))
        break
      }
      case 'like':
        clauses.push(`${col.sql} LIKE ? ESCAPE '\\'`)
        params.push(`%${escapeLike(String(f.value))}%`)
        break
      case 'isNull':
        clauses.push(`${col.sql} IS NULL`)
        break
      case 'notNull':
        clauses.push(`${col.sql} IS NOT NULL`)
        break
      default:
        throw new BadQuery(`Unknown operator "${String(f.op)}"`)
    }
  }
  if (search?.term) {
    const like = `%${escapeLike(search.term)}%`
    const exprs = search.fields.map((f) => (lookup(columns, f) ?? lookup(virtual, f))!.sql)
    clauses.push(`(${exprs.map((e) => `${e} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
    params.push(...search.fields.map(() => like))
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

export function buildOrderBy(columns: Columns, sorts: Sort[], fallback = 'id', virtual: Columns = {}) {
  const parts = sorts.map((s) => {
    const col = lookup(columns, s.field) ?? lookup(virtual, s.field)
    if (!col) throw new BadQuery(`Unknown sort field "${s.field}"`)
    return `${col.sql} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`
  })
  // stable ordering for pagination
  parts.push(`${columns[fallback]!.sql} ASC`)
  return `ORDER BY ${parts.join(', ')}`
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`)
