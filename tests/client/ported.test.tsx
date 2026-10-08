import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { Customer, CustomerBalance, Me, Page, Payment, Product, Subscription, Task } from '../../shared/domain'
import { meQuery } from '../../src/lib/auth'
import { predictSeatsMrr, seatPrice, useRecordPaymentOptimistic, useSeatsEditor } from '../../src/lib/mutations'
import { claimClientState, parsePins, pins, sortPins, usePins } from '../../src/lib/pins'
import { customerBalanceQuery, invoicePaymentsQuery, keys, nextUpByProject } from '../../src/lib/queries'
import { throttle } from '../../src/lib/throttle'

const page = <T,>(rows: T[]): Page<T> => ({ data: rows, total: rows.length, page: 1, pageSize: 25, pageCount: 1 })

/** fetch stub whose responses are resolved by hand */
function controlledFetch() {
  const calls: Array<{ url: string; method: string; body: unknown; resolve: (status: number, body?: unknown) => void }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((res) =>
          calls.push({
            url,
            method: init?.method ?? 'GET',
            body: init?.body ? JSON.parse(init.body as string) : undefined,
            resolve: (status, body) => res(new Response(body === undefined ? null : JSON.stringify(body), { status })),
          }),
        ),
    ),
  )
  return calls
}

const me = (id: number): Me => ({ user: { id } as Me['user'], permissions: [], teamIds: [] })
const wrap =
  (qc: QueryClient) =>
  ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('pins store', () => {
  beforeEach(() => localStorage.clear())

  it('persists pins as {id, pinnedAt} rows and toggles them', () => {
    pins.pin(3, '2026-01-01T00:00:00Z')
    pins.pin(5, '2026-01-02T00:00:00Z')
    expect(parsePins(localStorage.getItem('saasly:pins'))).toEqual([
      { id: 3, pinnedAt: '2026-01-01T00:00:00Z' },
      { id: 5, pinnedAt: '2026-01-02T00:00:00Z' },
    ])
    pins.toggle(3)
    expect(pins.list().map((p) => p.id)).toEqual([5])
    pins.clear()
    expect(pins.list()).toEqual([])
  })

  it('orders pins newest first and ignores malformed storage', () => {
    expect(
      sortPins([
        { id: 1, pinnedAt: '2026-01-01' },
        { id: 2, pinnedAt: '2026-02-01' },
      ]).map((p) => p.id),
    ).toEqual([2, 1])
    expect(parsePins('{nope')).toEqual([])
    expect(parsePins('[{"id":"x"},{"id":1,"pinnedAt":"t"}]')).toEqual([{ id: 1, pinnedAt: 't' }])
  })

  it('drops pins when a different user claims the client state', () => {
    claimClientState(1)
    pins.pin(7)
    claimClientState(1)
    expect(pins.list()).toHaveLength(1)
    claimClientState(2)
    expect(pins.list()).toEqual([])
    expect(localStorage.getItem('saasly:client-state-owner')).toBe('2')
  })

  it("usePins hides another user's pins and follows other tabs", async () => {
    localStorage.setItem('saasly:client-state-owner', '1')
    localStorage.setItem('saasly:pins', JSON.stringify([{ id: 9, pinnedAt: 't' }]))
    const qc = new QueryClient()
    qc.setQueryData(meQuery().queryKey, me(2))
    const { result } = renderHook(() => usePins(), { wrapper: wrap(qc) })
    expect(result.current).toEqual([])
    await waitFor(() => expect(localStorage.getItem('saasly:client-state-owner')).toBe('2'))
    expect(localStorage.getItem('saasly:pins')).toBe('[]')
    // another tab writes
    act(() => {
      localStorage.setItem('saasly:pins', JSON.stringify([{ id: 4, pinnedAt: 't' }]))
      window.dispatchEvent(new StorageEvent('storage', { key: 'saasly:pins' }))
    })
    expect(result.current).toEqual([{ id: 4, pinnedAt: 't' }])
  })
})

describe('throttle', () => {
  it('runs the first call at once and the latest of the rest once the window closes', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = throttle(fn, 500)
    t(1)
    t(2)
    t(3)
    expect(fn.mock.calls).toEqual([[1]])
    expect(t.pending()).toBe(true)
    vi.advanceTimersByTime(500)
    expect(fn.mock.calls).toEqual([[1], [3]])
    expect(t.pending()).toBe(false)
    t(4) // inside the window opened by the trailing call
    expect(fn).toHaveBeenCalledTimes(2)
    t.flush()
    expect(fn.mock.calls.at(-1)).toEqual([4])
  })
})

describe('next up per project', () => {
  it('keeps up to three not-done tasks per project, by position', () => {
    const task = (id: number, projectId: number, position: number, status: Task['status'] = 'todo') =>
      ({ id, projectId, position, status, title: `T${id}` }) as Task
    const map = nextUpByProject([
      task(1, 1, 4),
      task(2, 1, 1),
      task(3, 1, 2, 'done'),
      task(4, 1, 3),
      task(5, 1, 0),
      task(6, 2, 1),
    ])
    expect(map.get(1)?.map((t) => t.id)).toEqual([5, 2, 4])
    expect(map.get(2)?.map((t) => t.id)).toEqual([6])
  })
})

const customer: Customer = {
  id: 1,
  name: 'A',
  email: 'a@x.test',
  company: 'Acme',
  plan: 'pro',
  status: 'active',
  country: 'US',
  seats: 10,
  mrr: 50_000,
  ownerId: 1,
  teamId: null,
  createdAt: '',
  updatedAt: '',
}

describe('seats', () => {
  it('predicts MRR from the sold base-plan price, or the list price', () => {
    const products = [
      { id: 1, kind: 'plan', planCode: 'pro' },
      { id: 2, kind: 'addon', planCode: null },
    ] as Product[]
    const subs = [
      { id: 1, productId: 1, unitPrice: 4500, status: 'active' },
      { id: 2, productId: 2, unitPrice: 100, status: 'active' },
    ] as Subscription[]
    expect(seatPrice(customer, subs, products)).toBe(4500)
    expect(seatPrice(customer)).toBe(4900)
    expect(predictSeatsMrr(customer, 12, 4500)).toBe(59_000)
    expect(predictSeatsMrr({ ...customer, status: 'trial', mrr: 0 }, 12, 4500)).toBe(0)
  })

  it('moves the cache on every tick but PATCHes at most once per 500ms, then reconciles', async () => {
    const calls = controlledFetch()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(keys.customers.detail(1), customer)
    const { result } = renderHook(() => useSeatsEditor(1), { wrapper: wrap(qc) })
    const cached = () => qc.getQueryData<Customer>(keys.customers.detail(1))!

    act(() => result.current.setSeats(11, 10))
    act(() => result.current.setSeats(12, 11))
    act(() => result.current.setSeats(13, 12))
    expect(cached()).toMatchObject({ seats: 13, mrr: 50_000 + 3 * 4900 })
    expect(result.current).toMatchObject({ pending: true, draft: 13, saved: 10 })
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { seats: 11 } })

    act(() => calls[0]!.resolve(200, { ...customer, seats: 11, mrr: 55_000 }))
    await waitFor(() => expect(result.current.saved).toBe(11))
    expect(cached().seats).toBe(13) // the trailing value is still on its way
    await waitFor(() => expect(calls).toHaveLength(2), { timeout: 2000 })
    expect(calls[1]!.body).toEqual({ seats: 13 })
    act(() => calls[1]!.resolve(200, { ...customer, seats: 13, mrr: 64_000 }))
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(cached()).toMatchObject({ seats: 13, mrr: 64_000 })
  })
})

describe('optimistic payment', () => {
  it('shows a pending ledger row and moves the balance, then swaps in the server row', async () => {
    const calls = controlledFetch()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const paymentsKey = invoicePaymentsQuery(5).queryKey
    const balanceKey = customerBalanceQuery(1).queryKey
    qc.setQueryData(paymentsKey, page<Payment>([]))
    qc.setQueryData<CustomerBalance>(balanceKey, {
      id: 1,
      customerId: 1,
      invoiced: 0,
      paid: 0,
      outstanding: 1000,
      overdue: 1000,
      updatedAt: '',
    })
    const { result } = renderHook(() => useRecordPaymentOptimistic(), { wrapper: wrap(qc) })
    act(() => result.current.mutate({ invoiceId: 5, customerId: 1, amount: 100, overdue: true, method: 'card' }))
    await waitFor(() => expect(qc.getQueryData<Page<Payment>>(paymentsKey)!.data).toHaveLength(1))
    expect(qc.getQueryData<Page<Payment>>(paymentsKey)!.data[0]).toMatchObject({ reference: '', amount: 100 })
    expect(qc.getQueryData<CustomerBalance>(balanceKey)).toMatchObject({ outstanding: 900, overdue: 900, paid: 100 })

    const server = { id: 77, invoiceId: 5, customerId: 1, amount: 100, method: 'card', reference: 'CARD-5', receivedAt: '' }
    await waitFor(() => expect(calls).toHaveLength(1))
    act(() => calls[0]!.resolve(201, server))
    await waitFor(() => expect(qc.getQueryData<Page<Payment>>(paymentsKey)!.data[0]!.reference).toBe('CARD-5'))
  })

  it('rolls the row and the balance back when the server refuses', async () => {
    const calls = controlledFetch()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const paymentsKey = invoicePaymentsQuery(5).queryKey
    const balanceKey = customerBalanceQuery(1).queryKey
    qc.setQueryData(paymentsKey, page<Payment>([]))
    const balance: CustomerBalance = { id: 1, customerId: 1, invoiced: 0, paid: 0, outstanding: 1000, overdue: 0, updatedAt: '' }
    qc.setQueryData(balanceKey, balance)
    const { result } = renderHook(() => useRecordPaymentOptimistic(), { wrapper: wrap(qc) })
    act(() => result.current.mutate({ invoiceId: 5, customerId: 1, amount: 2000, overdue: false, method: 'card' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    act(() => calls[0]!.resolve(400, { error: 'BadRequest', message: 'Overpayment' }))
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(qc.getQueryData<Page<Payment>>(paymentsKey)!.data).toEqual([])
    expect(qc.getQueryData(balanceKey)).toEqual(balance)
  })
})
