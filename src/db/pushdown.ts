import { parseOrderByExpression, parseWhereExpression, type IR, type LoadSubsetOptions } from '@tanstack/react-db'

// Translates a live query's predicate (pushed down by an on-demand collection)
// into this API's REST list grammar:
//
//   where(and(inArray(e.type, [...]), eq(e.customerId, 7)))
//   .orderBy(e.id, 'desc').limit(31).offset(30)
//     ->  ?type[in]=a,b&customerId[eq]=7&sort=-id&limit=31&offset=30
//
// Two client-derived fields stand in for what the grammar can't say per field:
//
//   ilike(c.searchText, searchPattern('acme'))  ->  ?q=acme          (the server's search)
//   orderBy(c.order.mrr, 'desc')                ->  ?sort=-mrr,-id   (unique composite key)
//
// Anything the API can't express throws, so we never silently return the
// wrong window of rows.

type Pairs = Array<[string, string]>

/** What an on-demand collection's rows carry for push-down (see searchText() and sortKey()). */
export interface PushdownSpec {
  /** the derived field holding searchText() of exactly the columns the server's `?q=` searches */
  search?: string
  /** `order.<key>` composite sort keys -> the server's sort field for that key */
  sorts?: Readonly<Record<string, string>>
}

/** Rows keep their composite sort keys under this field: `row.order.mrr`. */
export const ORDER = 'order'

// ---------------------------------------------------------------------------
// Search: the server's `?q=` is a case-insensitive substring match over a fixed
// set of columns (LIKE '%term%', or the trigram index that returns the same
// rows). The client derives one lower-cased haystack from the same columns, so
// `ilike(row.searchText, '%term%')` keeps locally exactly the rows the server
// returned. LIKE wildcards are literal for the server (it escapes them), but
// TanStack DB's ilike has no escape character: `%` and `_` are mapped to
// control characters on both sides, so they stay literal locally too.
// ---------------------------------------------------------------------------
const WILDCARD: Record<string, string> = { '%': '\u0001', _: '\u0002' }
const escapeWildcards = (s: string) => s.replace(/[%_]/g, (m) => WILDCARD[m]!)

/** The haystack for `searchPattern()`: the searched columns, lower-cased, one per line. */
export const searchText = (...parts: Array<string | null | undefined>) =>
  escapeWildcards(
    parts
      .map((p) => p ?? '')
      .join('\n')
      .toLowerCase(),
  )

/** The `ilike` pattern for a search term (wildcards in the term are literal, as on the server). */
export const searchPattern = (term: string) => `%${escapeWildcards(term.toLowerCase())}%`

function searchTerm(pattern: unknown): string {
  const m = typeof pattern === 'string' ? /^%([^%_]+)%$/.exec(pattern) : null
  if (!m) throw new Error(`Only searchPattern() patterns can be pushed down as ?q=, got ${JSON.stringify(pattern)}`)
  return m[1]!.replaceAll(WILDCARD['%']!, '%').replaceAll(WILDCARD._!, '_')
}

// ---------------------------------------------------------------------------
// Sorting: TanStack DB cuts ordered windows by the *first* sort term. After a
// page loads it re-requests every row tied with the last row's value (all of
// them, unbounded) so that it never skips a duplicate. Sorting 250k customers
// by plan would mean "load every enterprise customer". So windows sort by a
// composite key that is unique and orders exactly like SQLite's
// `ORDER BY field, id` (NULLs first ascending, last descending; strings by
// code unit = SQLite's BINARY collation for this data): the tie group is one
// row, and `eq(row.order.mrr, key)` is simply `id[eq]=`.
// ---------------------------------------------------------------------------
const ID_WIDTH = 16 // 2^53 has 16 digits
const NUMBER_OFFSET = 2 ** 52

const pad = (n: number) => String(n).padStart(ID_WIDTH, '0')

function encodeNumber(n: number) {
  const shifted = n + NUMBER_OFFSET
  if (!Number.isInteger(n) || shifted < 0 || shifted >= 2 ** 53) throw new Error(`Cannot build a sort key for ${n}`)
  return pad(shifted)
}

/**
 * A composite, unique sort key for `ORDER BY value, id` as one string. Compare
 * with `stringSort: 'lexical'` (collections set it as their default).
 */
export function sortKey(value: string | number | null | undefined, id: number): string {
  if (!Number.isSafeInteger(id) || id < 0) throw new Error(`Cannot build a sort key for id ${id}`)
  const head = value === null || value === undefined ? '' : `\u0001${typeof value === 'number' ? encodeNumber(value) : value}`
  return `${head}\u0000${pad(id)}`
}

/** The row id inside a sortKey(). */
export const idOfSortKey = (key: string) => {
  const id = Number(key.slice(-ID_WIDTH))
  if (key.at(-ID_WIDTH - 1) !== '\u0000' || !Number.isSafeInteger(id)) throw new Error(`Not a sort key: ${JSON.stringify(key)}`)
  return id
}

/**
 * A lookup of one row by its unique key: the loader's tie request after an
 * ordered window — `eq(row.order.<field>, key)` for a composite sort key, or
 * `eq(row.id, id)` for windows sorted by id — possibly and-ed with the
 * window's filter. Its answer is a row the window request has just returned.
 */
export function uniqueLookup(
  where: LoadSubsetOptions['where'],
): { id: number | string; field?: string; key?: string } | undefined {
  if (!where || where.type !== 'func') return undefined
  if (where.name === 'and') {
    for (const arg of where.args) {
      const found = uniqueLookup(arg as LoadSubsetOptions['where'])
      if (found) return found
    }
    return undefined
  }
  const [subject, literal] = where.args
  if (where.name !== 'eq' || subject?.type !== 'ref' || literal?.type !== 'val') return undefined
  const path = subject.path
  if (path.length === 1 && path[0] === 'id' && (typeof literal.value === 'number' || typeof literal.value === 'string'))
    return { id: literal.value }
  if (path.length === 2 && path[0] === ORDER && typeof literal.value === 'string')
    return { id: idOfSortKey(literal.value), field: String(path[1]), key: literal.value }
  return undefined
}

// ---------------------------------------------------------------------------
// WHERE
// ---------------------------------------------------------------------------
const plainField = (path: Array<string | number>) => {
  if (path.length !== 1) throw new Error(`Nested field paths are not supported: ${path.join('.')}`)
  return String(path[0])
}
const value = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v))

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

export function whereToParams(where: LoadSubsetOptions['where'], spec: PushdownSpec = {}): Pairs {
  if (where) assertFieldVsLiteral(where)
  const isSortKey = (path: Array<string | number>) => path.length === 2 && path[0] === ORDER
  const field = (path: Array<string | number>) => {
    if (isSortKey(path)) throw new Error(`Only equality on a sort key can be pushed down (${path.join('.')})`)
    return plainField(path)
  }
  const cmp =
    (op: string) =>
    (path: Array<string | number>, v: unknown): Pairs => [[`${field(path)}[${op}]`, value(v)]]
  return (
    parseWhereExpression<Pairs>(where, {
      handlers: {
        // the loader's tie request for a composite sort key: that one row
        eq: (path: Array<string | number>, v: unknown): Pairs => {
          if (!isSortKey(path)) return cmp('eq')(path, v)
          if (!spec.sorts || !Object.hasOwn(spec.sorts, String(path[1]))) throw new Error(`Unknown sort key ${path.join('.')}`)
          return [['id[eq]', String(idOfSortKey(String(v)))]]
        },
        gt: cmp('gt'),
        gte: cmp('gte'),
        lt: cmp('lt'),
        lte: cmp('lte'),
        in: (path: Array<string | number>, values: unknown[]) => [[`${field(path)}[in]`, values.map(value).join(',')]],
        isNull: (path: Array<string | number>) => [[`${field(path)}[isNull]`, '']],
        ilike: (path: Array<string | number>, pattern: unknown): Pairs => {
          if (!spec.search || path.length !== 1 || path[0] !== spec.search)
            throw new Error(`ilike can only be pushed down on the search field${spec.search ? ` "${spec.search}"` : ''}`)
          return [['q', searchTerm(pattern)]]
        },
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

// ---------------------------------------------------------------------------
// ORDER BY
// ---------------------------------------------------------------------------
/** Fields that can never be NULL, so NULL placement doesn't matter when sorting by them. */
const NON_NULL = new Set(['id'])

/**
 * The API sorts in SQLite, which puts NULLs first ascending and last
 * descending, and compares strings by code point. A window cut with a
 * different order would be the wrong rows, so refuse what it can't honour:
 * a different NULL placement (TanStack DB defaults to NULLs first in both
 * directions — pass `nulls: 'last'` for descending sorts on nullable fields)
 * and custom comparators. A composite sort key must be the only term and
 * compare lexically (byte order, like SQLite).
 */
export function orderByToSort(orderBy: LoadSubsetOptions['orderBy'], spec: PushdownSpec = {}): string | undefined {
  const sorts = parseOrderByExpression(orderBy)
  if (!sorts.length) return undefined
  const [first] = sorts
  if (first!.field.length === 2 && first!.field[0] === ORDER) {
    const key = String(first!.field[1])
    const server = spec.sorts && Object.hasOwn(spec.sorts, key) ? spec.sorts[key] : undefined
    if (!server) throw new Error(`Unknown sort key ${first!.field.join('.')}`)
    if (first!.stringSort !== 'lexical') throw new Error(`Sort key ${key} must compare lexically (SQLite's byte order)`)
    // the key is unique: any further terms can never take effect
    const dir = first!.direction === 'desc' ? '-' : ''
    return `${dir}${server},${dir}id`
  }
  return sorts
    .map((s) => {
      const name = plainField(s.field)
      const sqliteNulls = s.direction === 'desc' ? 'last' : 'first'
      if (s.nulls !== sqliteNulls && !NON_NULL.has(name))
        throw new Error(`Cannot push down ${name} ${s.direction} with NULLs ${s.nulls}: the API sorts NULLs ${sqliteNulls}`)
      if (s.stringSort === 'custom') throw new Error(`Cannot push down a custom comparator for ${name}`)
      return `${s.direction === 'desc' ? '-' : ''}${name}`
    })
    .join(',')
}

/** The server's page size cap (MAX_PAGE_SIZE in server/db/params.ts). */
export const MAX_ROWS = 10_000

export function loadSubsetToSearch(opts: LoadSubsetOptions | undefined, spec: PushdownSpec = {}): URLSearchParams {
  const sp = new URLSearchParams()
  if (!opts) return sp
  for (const [k, v] of whereToParams(opts.where, spec)) sp.append(k, v)
  // order only matters to cut a window: an unbounded subset is sorted locally
  const sort = opts.limit === undefined ? undefined : orderByToSort(opts.orderBy, spec)
  if (sort) sp.set('sort', sort)
  if (opts.limit !== undefined) {
    // a deeper window would be silently capped by the server
    if (opts.limit > MAX_ROWS) throw new Error(`A window of ${opts.limit} rows is larger than the API serves (${MAX_ROWS})`)
    sp.set('limit', String(opts.limit))
  }
  if (opts.offset) sp.set('offset', String(opts.offset))
  // the API defaults to 25 rows per page: an unbounded subset asks for the cap,
  // and the caller checks the total so a bigger match is refused, not truncated
  if (opts.limit === undefined) sp.set('limit', String(MAX_ROWS))
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
