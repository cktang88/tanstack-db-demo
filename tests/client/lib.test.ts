import { describe, expect, it } from 'vite-plus/test'
import { toSearch } from '../../src/lib/api'
import { date, localToday, money, moneyCompact, month, relative, initials, titleCase } from '../../src/lib/format'
import { customersSearch as cs, formatSort, invoicesSearch as is, parseSort } from '../../src/lib/search'

const customersSearch = (s: Record<string, unknown>) => cs(s as never)
const invoicesSearch = (s: Record<string, unknown>) => is(s as never)
import { decodeCustomerForm } from '../../src/lib/validation'

describe('format', () => {
  it('formats cents', () => {
    expect(money(123456)).toBe('$1,235')
    expect(moneyCompact(1_234_567_00)).toBe('$1.2M')
  })
  it('formats months and relative times', () => {
    expect(month('2026-03')).toBe('Mar 26')
    expect(relative(new Date(Date.now() - 3 * 86400_000).toISOString())).toBe('3 days ago')
  })
  it('formats date-only strings without a time-zone shift', () => {
    expect(date('2026-10-08')).toBe('Oct 8, 2026')
    expect(date(null)).toBe('—')
    expect(localToday(new Date(2026, 0, 2, 23, 30))).toBe('2026-01-02')
  })
  it('formats names', () => {
    expect(initials('Grace Brewster Hopper')).toBe('GB')
    expect(titleCase('in_progress')).toBe('In Progress')
  })
})

describe('toSearch', () => {
  it('drops empty values and joins arrays', () => {
    expect(toSearch({ a: 1, b: undefined, c: '', d: ['x', 'y'], e: [], f: null })).toBe('?a=1&d=x%2Cy')
    expect(toSearch({})).toBe('')
  })
})

describe('search param validators', () => {
  it('applies defaults', () => {
    expect(customersSearch({})).toEqual({
      page: 1,
      pageSize: 25,
      sort: '-createdAt',
      q: undefined,
      status: undefined,
      plan: undefined,
      country: undefined,
      ownerId: undefined,
    })
  })
  it('sanitises garbage from the URL', () => {
    const s = customersSearch({
      page: '-4',
      pageSize: 100000,
      sort: 'drop table',
      status: ['active', 'hacked'],
      plan: 'pro,nope',
    })
    expect(s).toMatchObject({ page: 1, pageSize: 25, sort: '-createdAt', status: ['active'], plan: ['pro'] })
  })
  it('accepts multi-column sorts', () => {
    expect(customersSearch({ sort: '-createdAt,company' }).sort).toBe('-createdAt,company')
    expect(invoicesSearch({ sort: 'status,-amount' }).sort).toBe('status,-amount')
    expect(customersSearch({ sort: 'company,' }).sort).toBe('-createdAt')
  })
  it('validates invoice dates', () => {
    expect(invoicesSearch({ issuedFrom: '2026-01-01', issuedTo: 'yesterday' })).toMatchObject({
      issuedFrom: '2026-01-01',
      issuedTo: undefined,
    })
  })
  it('round-trips sort state', () => {
    const sorting = parseSort('-mrr,name')
    expect(sorting).toEqual([
      { id: 'mrr', desc: true },
      { id: 'name', desc: false },
    ])
    expect(formatSort(sorting)).toBe('-mrr,name')
    expect(formatSort([])).toBeUndefined()
  })
})

describe('customer form schema (shared Effect Schema)', () => {
  const valid = {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    company: 'Analytical',
    plan: 'pro',
    status: 'trial',
    country: 'GB',
    seats: '3',
    ownerId: '',
  }
  it('decodes strings into typed values', () => {
    expect(decodeCustomerForm(valid)).toEqual({ ok: true, value: { ...valid, seats: 3, ownerId: null } })
    expect(decodeCustomerForm({ ...valid, ownerId: '4' })).toMatchObject({ ok: true, value: { ownerId: 4 } })
  })
  it('collects a message per field', () => {
    const r = decodeCustomerForm({ ...valid, name: 'A', email: 'nope', seats: '0' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(Object.keys(r.errors).sort()).toEqual(['email', 'name', 'seats'])
      expect(r.errors.email).toBe('Enter a valid email address')
    }
  })
})
