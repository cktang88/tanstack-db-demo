import { describe, expect, it } from 'vite-plus/test'
import { parseListParams } from '../../server/db/params.ts'
import { BadQuery, buildOrderBy, buildWhere, type Columns } from '../../server/db/sql.ts'

const cols: Columns = {
  id: { sql: 'id', type: 'number' },
  name: { sql: 'name', type: 'text' },
  mrr: { sql: 'mrr', type: 'number' },
  active: { sql: 'active', type: 'bool' },
}

describe('parseListParams', () => {
  it('parses page/pageSize into limit/offset', () => {
    const p = parseListParams(new URLSearchParams('page=3&pageSize=20'))
    expect(p).toMatchObject({ limit: 20, offset: 40, filters: [], sorts: [] })
  })

  it('parses sorts, search and filter shorthands', () => {
    const p = parseListParams(
      new URLSearchParams('sort=-mrr,name&q=acme&status=active,trial&plan=pro&mrr[gte]=100&ownerId[isNull]='),
    )
    expect(p.sorts).toEqual([
      { field: 'mrr', dir: 'desc' },
      { field: 'name', dir: 'asc' },
    ])
    expect(p.search).toBe('acme')
    expect(p.filters).toEqual([
      { field: 'status', op: 'in', value: ['active', 'trial'] },
      { field: 'plan', op: 'eq', value: 'pro' },
      { field: 'mrr', op: 'gte', value: '100' },
      { field: 'ownerId', op: 'isNull', value: '' },
    ])
  })

  it('prefers raw limit/offset when present', () => {
    expect(parseListParams(new URLSearchParams('limit=5&offset=10&page=9'))).toMatchObject({ limit: 5, offset: 10 })
  })

  it('rejects bad operators and numbers', () => {
    expect(() => parseListParams(new URLSearchParams('mrr[drop]=1'))).toThrow(BadQuery)
    expect(() => parseListParams(new URLSearchParams('limit=-1'))).toThrow(BadQuery)
    expect(() => parseListParams(new URLSearchParams('a;b=1'))).toThrow(BadQuery)
  })

  it('caps page size', () => {
    expect(parseListParams(new URLSearchParams('limit=999999')).limit).toBe(10_000)
  })
})

describe('buildWhere', () => {
  it('builds parameterised clauses', () => {
    const w = buildWhere(cols, [
      { field: 'mrr', op: 'gt', value: '5' },
      { field: 'name', op: 'in', value: ['a', 'b'] },
      { field: 'active', op: 'eq', value: 'true' },
    ])
    expect(w.sql).toBe('WHERE mrr > ? AND name IN (?,?) AND active = ?')
    expect(w.params).toEqual([5, 'a', 'b', 1])
  })

  it('escapes LIKE wildcards in search', () => {
    const w = buildWhere(cols, [], { term: '50%_off', fields: ['name'] })
    expect(w.params).toEqual(['%50\\%\\_off%'])
  })

  it('rejects unknown fields (no SQL injection through identifiers)', () => {
    expect(() => buildWhere(cols, [{ field: 'name; DROP TABLE x', op: 'eq', value: 1 }])).toThrow(BadQuery)
    expect(() => buildOrderBy(cols, [{ field: 'nope', dir: 'asc' }])).toThrow(BadQuery)
  })

  it('rejects non-numeric values for number columns', () => {
    expect(() => buildWhere(cols, [{ field: 'mrr', op: 'eq', value: 'abc' }])).toThrow(BadQuery)
  })

  it('orders with a stable id tiebreaker', () => {
    expect(buildOrderBy(cols, [{ field: 'mrr', dir: 'desc' }])).toBe('ORDER BY mrr DESC, id ASC')
  })
})
