import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vite-plus/test'
import type { Customer, Page } from '../../shared/domain'
import { BIG_ACCOUNT_MRR, cachedCustomer, createCustomerAlerts, customerAlerts, idsOf } from '../../src/lib/alerts'
import { keys } from '../../src/lib/queries'

const customer = (id: number, patch: Partial<Customer> = {}): Customer => ({
  id,
  name: `C${id}`,
  email: `c${id}@x.test`,
  company: `Co ${id}`,
  plan: 'pro',
  status: 'active',
  country: 'US',
  seats: 1,
  mrr: 10_000,
  ownerId: 1,
  teamId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...patch,
})
const page = (rows: Customer[]): Page<Customer> => ({ data: rows, total: rows.length, page: 1, pageSize: 25, pageCount: 1 })
const listKey = keys.customers.list({ page: 1, pageSize: 25 })
const upsert = (row: Customer) => ({ kind: 'upsert', entity: 'customers', row })

function setup(rows: Customer[] = [customer(1)]) {
  const qc = new QueryClient()
  qc.setQueryData(listKey, page(rows))
  const notify = vi.fn()
  const alerts = createCustomerAlerts(qc, notify)
  const stop = alerts.watchMutations()
  const kinds = () => notify.mock.calls.map(([a]) => `${a.kind}:${a.customer.id}`)
  return { qc, alerts, notify, kinds, stop }
}

/** run a customer mutation through the cache, optionally patching the cache optimistically */
function mutate(qc: QueryClient, key: string[], variables: unknown, result: () => unknown, optimistic?: Partial<Customer>) {
  let resolve!: () => void
  const gate = new Promise<void>((r) => (resolve = r))
  const m = qc.getMutationCache().build(qc, {
    mutationKey: key,
    mutationFn: async () => {
      await gate
      return result()
    },
    onMutate: () => {
      if (!optimistic) return
      for (const id of idsOf(variables))
        qc.setQueryData<Page<Customer>>(
          listKey,
          (p) => p && { ...p, data: p.data.map((c) => (c.id === id ? { ...c, ...optimistic } : c)) },
        )
    },
  })
  const done = m.execute(variables)
  return { finish: async () => (resolve(), await done) }
}

describe('customerAlerts', () => {
  it('fires on transitions into churned / $20k+ only', () => {
    const active = customer(1)
    expect(customerAlerts(active, { ...active, status: 'churned' }).map((a) => a.kind)).toEqual(['churned'])
    expect(customerAlerts({ ...active, status: 'churned' }, { ...active, status: 'churned', mrr: 5 })).toEqual([])
    expect(customerAlerts(active, { ...active, mrr: BIG_ACCOUNT_MRR + 1 }).map((a) => a.kind)).toEqual(['big-account'])
    expect(customerAlerts({ ...active, mrr: BIG_ACCOUNT_MRR + 1 }, { ...active, mrr: BIG_ACCOUNT_MRR + 2 })).toEqual([])
    expect(customerAlerts(active, { ...active, mrr: BIG_ACCOUNT_MRR })).toEqual([])
    // a brand-new row counts as entering
    expect(customerAlerts(undefined, { ...active, status: 'churned' }).map((a) => a.kind)).toEqual(['churned'])
  })

  it('reads ids out of mutation variables', () => {
    expect(idsOf(3)).toEqual([3])
    expect(idsOf([1, 2])).toEqual([1, 2])
    expect(idsOf({ id: 4, patch: {} })).toEqual([4])
    expect(idsOf({ ids: [5, 6], patch: {} })).toEqual([5, 6])
    expect(idsOf({ name: 'x' })).toEqual([])
  })

  it('finds the newest cached version of a customer', () => {
    const qc = new QueryClient()
    qc.setQueryData(listKey, page([customer(1)]), { updatedAt: 1 })
    qc.setQueryData(keys.customers.detail(1), customer(1, { status: 'trial' }), { updatedAt: 2 })
    expect(cachedCustomer(qc, 1)?.row.status).toBe('trial')
    expect(cachedCustomer(qc, 2)).toBeUndefined()
  })
})

describe('createCustomerAlerts — server changes', () => {
  it('compares pushed rows with the cached version and fires once per transition', () => {
    const { alerts, kinds } = setup([customer(1), customer(2, { mrr: BIG_ACCOUNT_MRR - 1 })])
    alerts.onChange(upsert(customer(1, { status: 'churned', mrr: 0 })))
    alerts.onChange(upsert(customer(1, { status: 'churned', mrr: 0 }))) // a second echo of the same change
    alerts.onChange(upsert(customer(2, { mrr: BIG_ACCOUNT_MRR + 100 })))
    alerts.onChange(upsert(customer(2, { mrr: BIG_ACCOUNT_MRR + 200 })))
    expect(kinds()).toEqual(['churned:1', 'big-account:2'])
  })

  it('never fires for rows it has nothing to compare with, nor for other entities or deletes', () => {
    const { alerts, kinds } = setup([])
    alerts.onChange(upsert(customer(9, { status: 'churned' })))
    alerts.onChange({ kind: 'upsert', entity: 'invoices', row: { id: 1, status: 'churned' } })
    alerts.onChange({ kind: 'delete', entity: 'customers' })
    expect(kinds()).toEqual([])
    // …but a row seen once is compared from then on
    alerts.onChange(upsert(customer(9, { status: 'active' })))
    alerts.onChange(upsert(customer(9, { status: 'churned' })))
    expect(kinds()).toEqual(['churned:9'])
  })

  it('prefers a fresher refetched cache over what it remembered', () => {
    const { qc, alerts, kinds } = setup()
    alerts.onChange(upsert(customer(1, { status: 'churned' })))
    // reactivated, and we only learn about it through a refetch
    qc.setQueryData(listKey, page([customer(1, { status: 'active' })]), { updatedAt: Date.now() + 1000 })
    alerts.onChange(upsert(customer(1, { status: 'churned' })))
    expect(kinds()).toEqual(['churned:1', 'churned:1'])
  })
})

describe('createCustomerAlerts — our own mutations', () => {
  it('compares the result with the row before the optimistic patch (and ignores the echo)', async () => {
    const { qc, alerts, kinds } = setup()
    const m = mutate(
      qc,
      ['customers', 'update'],
      { id: 1, patch: { status: 'churned' } },
      () => customer(1, { status: 'churned' }),
      {
        status: 'churned',
      },
    )
    await Promise.resolve()
    expect(cachedCustomer(qc, 1)?.row.status).toBe('churned') // optimistic
    alerts.onChange(upsert(customer(1, { status: 'churned', mrr: 0 }))) // echo while in flight
    expect(kinds()).toEqual([])
    await m.finish()
    expect(kinds()).toEqual(['churned:1'])
    alerts.onChange(upsert(customer(1, { status: 'churned', mrr: 0 }))) // late echo
    expect(kinds()).toEqual(['churned:1'])
  })

  it('handles bulk results ({ ok: [{ value }] }) and creates', async () => {
    const { qc, kinds } = setup([customer(1), customer(2), customer(3, { status: 'churned' })])
    const bulk = mutate(
      qc,
      ['customers', 'bulk-update'],
      { ids: [1, 2, 3], patch: { status: 'churned' } },
      () => ({ ok: [1, 2, 3].map((id) => ({ id, value: customer(id, { status: 'churned' }) })), failed: [] }),
      { status: 'churned' },
    )
    await bulk.finish()
    expect(kinds()).toEqual(['churned:1', 'churned:2'])
    const create = mutate(qc, ['customers', 'create'], { company: 'New' }, () => customer(7, { mrr: BIG_ACCOUNT_MRR * 2 }))
    await create.finish()
    expect(kinds()).toEqual(['churned:1', 'churned:2', 'big-account:7'])
  })

  it('ignores failed and non-customer mutations, and stops when unsubscribed', async () => {
    const { qc, kinds, stop } = setup()
    const failing = qc.getMutationCache().build(qc, {
      mutationKey: ['customers', 'update'],
      mutationFn: () => Promise.reject(new Error('nope')),
    })
    await failing.execute({ id: 1 }).catch(() => {})
    await mutate(qc, ['tasks', 'update'], { id: 1 }, () => customer(1, { status: 'churned' })).finish()
    stop()
    await mutate(qc, ['customers', 'update'], { id: 1 }, () => customer(1, { status: 'churned' })).finish()
    expect(kinds()).toEqual([])
  })
})

describe('startLiveUpdates', () => {
  it('hands every change message to onChange before invalidating', async () => {
    const { startLiveUpdates } = await import('../../src/lib/live')
    const sources: FakeEventSource[] = []
    class FakeEventSource {
      static CLOSED = 2
      readyState = 1
      listeners = new Map<string, (e: MessageEvent<string>) => void>()
      constructor(readonly url: string) {
        sources.push(this)
      }
      addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
        this.listeners.set(type, fn)
      }
      close() {}
      emit(type: string, data: unknown) {
        this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>)
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    try {
      const { qc, alerts, kinds } = setup()
      const onChange = vi.fn(alerts.onChange)
      const stop = startLiveUpdates(qc, { onChange })
      sources[0]!.emit('change', upsert(customer(1, { status: 'churned' })))
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(kinds()).toEqual(['churned:1'])
      stop()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
