import { parseOrderByExpression, parseWhereExpression, type IR, type LoadSubsetOptions } from '@tanstack/react-db'

// Translates a live query's predicate (pushed down by an on-demand collection)
// into this API's REST list grammar:
//
//   where(and(inArray(e.type, [...]), eq(e.customerId, 7)))
//   .orderBy(e.createdAt, 'desc').orderBy(e.id, 'desc').limit(31).offset(30)
//     ->  ?type[in]=a,b&customerId[eq]=7&sort=-createdAt,-id&limit=31&offset=30
//
// Anything the API can't express throws, so we never silently return the
// wrong window of rows.

type Pairs = Array<[string, string]>

const field = (path: Array<string | number>) => {
  if (path.length !== 1) throw new Error(`Nested field paths are not supported: ${path.join('.')}`)
  return String(path[0])
}
const value = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v))
const cmp =
  (op: string) =>
  (path: Array<string | number>, v: unknown): Pairs => [[`${field(path)}[${op}]`, value(v)]]

const NEGATE: Record<string, string> = { eq: 'neq', isNull: 'notNull' }
const LOGICAL = new Set(['and', 'not'])

/**
 * The REST grammar only expresses `field <op> literal`. Check the shape on the
 * raw expression first: once parsed, a field reference (`eq(a.x, a.y)`) and a
 * literal array look the same, and would be sent as a bogus literal.
 */
function assertFieldVsLiteral(e: IR.BasicExpression) {
  if (e.type !== 'func') return
  if (LOGICAL.has(e.name)) return e.args.forEach(assertFieldVsLiteral)
  const [subject, ...values] = e.args
  if (subject?.type !== 'ref') throw new Error(`${e.name}: the left-hand side must be a field`)
  for (const v of values) {
    if (v.type !== 'val') throw new Error(`${e.name}: only comparisons against literal values can be pushed down`)
    if (Array.isArray(v.value) !== (e.name === 'in'))
      throw new Error(`${e.name}: ${e.name === 'in' ? 'expected a list of values' : 'unexpected list value'}`)
  }
}

export function whereToParams(where: LoadSubsetOptions['where']): Pairs {
  if (where) assertFieldVsLiteral(where)
  return (
    parseWhereExpression<Pairs>(where, {
      handlers: {
        eq: cmp('eq'),
        gt: cmp('gt'),
        gte: cmp('gte'),
        lt: cmp('lt'),
        lte: cmp('lte'),
        in: (path: Array<string | number>, values: unknown[]) => [[`${field(path)}[in]`, values.map(value).join(',')]],
        isNull: (path: Array<string | number>) => [[`${field(path)}[isNull]`, '']],
        and: (...parts: Pairs[]) => parts.flat(),
        not: (inner: Pairs) => {
          if (inner.length !== 1) throw new Error('Only single-comparison NOT is supported')
          const [key, v] = inner[0]!
          const m = /^(.*)\[(\w+)\]$/.exec(key)
          const negated = m && NEGATE[m[2]!]
          if (!negated) throw new Error(`Cannot negate ${key}`)
          return [[`${m[1]}[${negated}]`, v]]
        },
      },
    }) ?? []
  )
}

/** Fields that can never be NULL, so NULL placement doesn't matter when sorting by them. */
const NON_NULL = new Set(['id'])

/**
 * The API sorts in SQLite, which puts NULLs first ascending and last
 * descending, and compares strings by code point. A window cut with a
 * different order would be the wrong rows, so refuse what it can't honour:
 * a different NULL placement (TanStack DB defaults to NULLs first in both
 * directions — pass `nulls: 'last'` for descending sorts on nullable fields)
 * and custom comparators. (Locale string collation, the TanStack default, is
 * accepted: the fields sorted on demand here are ids, dates and codes, where
 * it agrees with SQLite.)
 */
export function orderByToSort(orderBy: LoadSubsetOptions['orderBy']): string | undefined {
  const sorts = parseOrderByExpression(orderBy)
  if (!sorts.length) return undefined
  return sorts
    .map((s) => {
      const name = field(s.field)
      const sqliteNulls = s.direction === 'desc' ? 'last' : 'first'
      if (s.nulls !== sqliteNulls && !NON_NULL.has(name))
        throw new Error(`Cannot push down ${name} ${s.direction} with NULLs ${s.nulls}: the API sorts NULLs ${sqliteNulls}`)
      if (s.stringSort === 'custom') throw new Error(`Cannot push down a custom comparator for ${name}`)
      return `${s.direction === 'desc' ? '-' : ''}${name}`
    })
    .join(',')
}

export function loadSubsetToSearch(opts: LoadSubsetOptions | undefined): URLSearchParams {
  const sp = new URLSearchParams()
  if (!opts) return sp
  for (const [k, v] of whereToParams(opts.where)) sp.append(k, v)
  const sort = orderByToSort(opts.orderBy)
  if (sort) sp.set('sort', sort)
  if (opts.limit !== undefined) sp.set('limit', String(opts.limit))
  if (opts.offset) sp.set('offset', String(opts.offset))
  // the API defaults to 25 rows per page; an unlimited subset must ask for everything
  if (opts.limit === undefined) sp.set('limit', '10000')
  return sp
}

/**
 * A window that a keyset (cursor) feed can serve: no filter beyond the
 * collection's fixed scope, newest-first by `id`, bounded.
 */
export function isNewestFirstWindow(opts: LoadSubsetOptions | undefined): opts is LoadSubsetOptions & { limit: number } {
  if (!opts || opts.where || opts.limit === undefined) return false
  const sorts = parseOrderByExpression(opts.orderBy)
  return sorts.length === 1 && sorts[0]!.direction === 'desc' && sorts[0]!.field.join('.') === 'id'
}
