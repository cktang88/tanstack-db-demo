import { BadQuery, type Filter, type FilterOp, type ListParams, type Sort } from './sql.ts'

const OPS = new Set<FilterOp>(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'like', 'isNull', 'notNull'])
const RESERVED = new Set(['page', 'pageSize', 'limit', 'offset', 'sort', 'q', 'sum'])
const MAX_PAGE_SIZE = 10_000

/**
 * Parses a URL query string into ListParams.
 *
 *   ?page=2&pageSize=25            -> offset/limit pagination (1-based page)
 *   ?limit=50&offset=100           -> raw offset/limit (limit defaults to / is capped at MAX_PAGE_SIZE)
 *   ?sort=-mrr,name                -> ORDER BY mrr DESC, name ASC
 *   ?q=acme                        -> free text search
 *   ?status=active,trial           -> status IN (...)  (shorthand)
 *   ?mrr[gte]=1000&ownerId[isNull] -> explicit operators
 *   ?sum=mrr,seats                 -> also total these fields over every matching row
 */
export function parseListParams(query: URLSearchParams, defaults: { pageSize?: number } = {}): ListParams {
  const filters: Filter[] = []
  for (const [rawKey, value] of query) {
    const m = /^([A-Za-z]+)(?:\[([A-Za-z]+)\])?$/.exec(rawKey)
    if (!m) throw new BadQuery(`Malformed query key "${rawKey}"`)
    const [, field, op] = m as unknown as [string, string, string | undefined]
    if (RESERVED.has(field)) continue
    if (op === undefined) {
      filters.push({ field, op: value.includes(',') ? 'in' : 'eq', value: value.includes(',') ? value.split(',') : value })
    } else {
      if (!OPS.has(op as FilterOp)) throw new BadQuery(`Unknown operator "${op}"`)
      filters.push({ field, op: op as FilterOp, value: op === 'in' ? value.split(',') : value })
    }
  }

  const sorts: Sort[] = (query.get('sort') ?? '')
    .split(',')
    .filter(Boolean)
    .map((s) => (s.startsWith('-') ? { field: s.slice(1), dir: 'desc' } : { field: s, dir: 'asc' }))

  let limit: number | undefined
  let offset: number | undefined
  const num = (k: string) => {
    const v = query.get(k)
    if (v === null) return undefined
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) throw new BadQuery(`"${k}" must be a non-negative integer`)
    return n
  }
  if (query.has('limit') || query.has('offset')) {
    // an offset always comes with a bounded window (never "the rest of the table")
    limit = num('limit') ?? MAX_PAGE_SIZE
    offset = num('offset')
  } else {
    const pageSize = Math.min(num('pageSize') ?? defaults.pageSize ?? 25, MAX_PAGE_SIZE)
    const page = Math.max(1, num('page') ?? 1)
    limit = pageSize
    offset = (page - 1) * pageSize
  }
  if (limit !== undefined) limit = Math.min(limit, MAX_PAGE_SIZE)

  const sums = (query.get('sum') ?? '').split(',').filter(Boolean)
  for (const f of sums) if (!/^[A-Za-z]+$/.test(f)) throw new BadQuery(`Malformed sum field "${f}"`)

  return { filters, sorts, search: query.get('q') || undefined, limit, offset, ...(sums.length && { sums }) }
}
