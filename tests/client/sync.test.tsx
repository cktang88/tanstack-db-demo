import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Customer, Me, Page } from '../../shared/domain'
import { permissionsFor, safeRedirect } from '../../src/lib/auth'
import { useUpdateCustomer } from '../../src/lib/mutations'
import { keys } from '../../src/lib/queries'
import { invalidateEntities } from '../../src/lib/sync'

const customer = (id: number): Customer => ({
  id,
  name: `C${id}`,
  email: `c${id}@x.test`,
  company: `Co ${id}`,
  plan: 'starter',
  status: 'trial',
  country: 'US',
  seats: 1,
  mrr: 0,
  ownerId: 1,
  teamId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
})
const page = (rows: Customer[]): Page<Customer> => ({ data: rows, total: rows.length, page: 1, pageSize: 25, pageCount: 1 })
const listKey = keys.customers.list({ page: 1, pageSize: 25 })

afterEach(() => vi.unstubAllGlobals())

/** fetch stub whose responses are resolved by hand, in any order */
function controlledFetch() {
  const calls: Array<{ url: string; method: string; resolve: (status: number, body?: unknown) => void }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((res) =>
          calls.push({
            url,
            method: init?.method ?? 'GET',
            resolve: (status, body) => res(new Response(body === undefined ? null : JSON.stringify(body), { status })),
          }),
        ),
    ),
  )
  return calls
}

describe('invalidateEntities', () => {
  it('skips entities that still have other writes in flight', async () => {
    const qc = new QueryClient()
    qc.setQueryData(listKey, page([customer(1)]))
    qc.setQueryData(['payments', 'list', {}], page([]))
    const pending = qc
      .getMutationCache()
      .build(qc, { mutationKey: ['customers', 'update'], mutationFn: () => new Promise(() => {}) })
    void pending.execute(undefined)
    await invalidateEntities(qc, ['customers', 'payments'])
    expect(qc.getQueryState(listKey)?.isInvalidated).toBe(false)
    expect(qc.getQueryState(['payments', 'list', {}])?.isInvalidated).toBe(true)
    // the settling mutation itself doesn't count
    await invalidateEntities(qc, ['customers'], { self: 'customers' })
    expect(qc.getQueryState(listKey)?.isInvalidated).toBe(true)
  })
})

describe('concurrent optimistic updates', () => {
  it("a failing update rolls back only its own change and doesn't refetch over the other", async () => {
    const calls = controlledFetch()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(listKey, page([customer(1), customer(2)]))
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    const a = renderHook(() => useUpdateCustomer(1), { wrapper })
    const b = renderHook(() => useUpdateCustomer(2), { wrapper })
    const rows = () => qc.getQueryData<Page<Customer>>(listKey)!.data

    act(() => a.result.current.mutate({ id: 1, patch: { status: 'active' } }))
    act(() => b.result.current.mutate({ id: 2, patch: { plan: 'pro' } }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(rows().map((c) => [c.status, c.plan])).toEqual([
      ['active', 'starter'],
      ['trial', 'pro'],
    ])

    calls[0]!.resolve(500, { error: 'Boom', message: 'Boom' })
    await waitFor(() => expect(rows()[0]!.status).toBe('trial'))
    expect(rows()[1]!.plan).toBe('pro') // B's optimistic state survives A's rollback
    expect(qc.getQueryState(listKey)?.isInvalidated).toBe(false) // no refetch while B is in flight

    calls[1]!.resolve(200, { ...customer(2), plan: 'pro', mrr: 4900 })
    await waitFor(() => expect(qc.getQueryState(listKey)?.isInvalidated).toBe(true))
    expect(rows()[1]!.mrr).toBe(4900)
  })
})

describe('auth helpers', () => {
  const me = (role: Me['user']['role'], permissions: Me['permissions'], teamIds: number[] = []): Me => ({
    user: { id: 4, name: 'M', email: 'm@x', role, title: '', avatarColor: '', active: true, createdAt: '' } as Me['user'],
    permissions,
    teamIds,
  })

  it('mirrors the server row rules for projects and tasks', () => {
    const member = permissionsFor(me('member', ['projects:write'], [2]))
    expect(member.canEditProject({ teamId: 2, ownerId: null })).toBe(true)
    expect(member.canEditProject({ teamId: 3, ownerId: null })).toBe(false)
    expect(member.canEditProject({ teamId: 3, ownerId: 4 })).toBe(true)
    expect(member.canEditTask({ assigneeId: 4 }, { teamId: 3, ownerId: null })).toBe(true)
    expect(member.canEditTask({ assigneeId: 9 }, { teamId: 3, ownerId: null })).toBe(false)
    const viewer = permissionsFor(me('viewer', []))
    expect(viewer.canEditTask({ assigneeId: 4 }, { teamId: 2, ownerId: 4 })).toBe(false)
    expect(permissionsFor(me('admin', ['projects:write'])).canEditProject({ teamId: 3, ownerId: 1 })).toBe(true)
  })

  it('only follows in-app redirects', () => {
    expect(safeRedirect('/customers?page=2')).toBe('/customers?page=2')
    expect(safeRedirect('//evil.example')).toBe('/')
    expect(safeRedirect('https://evil.example')).toBe('/')
    expect(safeRedirect('/login?redirect=/x')).toBe('/')
    expect(safeRedirect(undefined)).toBe('/')
  })
})
