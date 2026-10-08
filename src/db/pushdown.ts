import { parseOrderByExpression, parseWhereExpression, type LoadSubsetOptions } from '@tanstack/react-db'

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

export function whereToParams(where: LoadSubsetOptions['where']): Pairs {
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

export function loadSubsetToSearch(opts: LoadSubsetOptions | undefined): URLSearchParams {
  const sp = new URLSearchParams()
  if (!opts) return sp
  for (const [k, v] of whereToParams(opts.where)) sp.append(k, v)
  const sorts = parseOrderByExpression(opts.orderBy)
  if (sorts.length) sp.set('sort', sorts.map((s) => `${s.direction === 'desc' ? '-' : ''}${field(s.field)}`).join(','))
  if (opts.limit !== undefined) sp.set('limit', String(opts.limit))
  if (opts.offset) sp.set('offset', String(opts.offset))
  // the API defaults to 25 rows per page; an unlimited subset must ask for everything
  if (opts.limit === undefined) sp.set('limit', '10000')
  return sp
}
