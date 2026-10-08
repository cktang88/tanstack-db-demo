import { useMutationState, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { Subscription } from '../../shared/domain'
import { Badge, Card, PageHeader } from '../components/ui'
import { useCan } from '../lib/auth'
import { money, number } from '../lib/format'
import { useSaveProduct } from '../lib/mutations'
import { productsQuery, resourceList } from '../lib/queries'

export function ProductsPage() {
  const { data: products } = useSuspenseQuery(productsQuery())
  // adoption per product: aggregated client-side from every active subscription (a big list for one number each)
  const { data: subs = [] } = useQuery(resourceList<Subscription>('subscriptions', { status: 'active,past_due', limit: 10000 }))
  const { can } = useCan()
  const save = useSaveProduct()
  // rows with an optimistic edit still in flight
  const pending = new Set(
    useMutationState({
      filters: { mutationKey: ['products', 'update'], status: 'pending' },
      select: (m) => (m.state.variables as { id: number } | undefined)?.id,
    }),
  )
  const adoption = useMemo(() => {
    const m = new Map<number, { subs: number; units: number; mrr: number }>()
    for (const s of subs) {
      const a = m.get(s.productId) ?? { subs: 0, units: 0, mrr: 0 }
      a.subs++
      a.units += s.quantity
      a.mrr += s.quantity * s.unitPrice
      m.set(s.productId, a)
    }
    return m
  }, [subs])
  const editable = can('products:write')

  return (
    <>
      <PageHeader title="Products" description="Catalog of plans and add-ons. Prices are locked into subscriptions at signup." />
      <Card>
        <table className="w-full" data-testid="products-table">
          <thead>
            <tr>
              <th className="th">SKU</th>
              <th className="th">Name</th>
              <th className="th">Kind</th>
              <th className="th text-right">List price</th>
              <th className="th text-right">Active subs</th>
              <th className="th text-right">Units</th>
              <th className="th text-right">MRR</th>
              <th className="th">For sale</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {products.map((p) => {
              const a = adoption.get(p.id)
              return (
                <tr
                  key={p.id}
                  data-testid="product-row"
                  className={pending.has(p.id) ? 'bg-amber-50/50 dark:bg-amber-500/5' : undefined}
                >
                  <td className="td font-mono text-xs">{p.sku}</td>
                  <td className="td">{p.name}</td>
                  <td className="td">
                    <Badge value={p.planCode ?? p.kind} />
                  </td>
                  <td className="td text-right">
                    {editable ? (
                      <input
                        // remounts with the current price whenever it changes — including a rollback
                        key={p.unitPrice}
                        type="number"
                        className="input w-28 text-right"
                        aria-label={`Price of ${p.sku}`}
                        defaultValue={p.unitPrice / 100}
                        min={0}
                        step={1}
                        onBlur={(e) => {
                          const input = e.currentTarget
                          const raw = input.value.trim()
                          const cents = Math.round(Number(raw) * 100)
                          // empty / invalid / negative input is not "$0": put the current price back
                          if (raw === '' || !Number.isFinite(cents) || cents < 0) {
                            input.value = String(p.unitPrice / 100)
                            return
                          }
                          if (cents !== p.unitPrice) save.mutate({ id: p.id, patch: { unitPrice: cents } })
                        }}
                      />
                    ) : (
                      money(p.unitPrice)
                    )}
                  </td>
                  <td className="td text-right tabular-nums">{number(a?.subs ?? 0)}</td>
                  <td className="td text-right tabular-nums">{number(a?.units ?? 0)}</td>
                  <td className="td text-right tabular-nums">{money(a?.mrr ?? 0)}</td>
                  <td className="td">
                    <input
                      type="checkbox"
                      aria-label={`${p.sku} for sale`}
                      checked={p.active}
                      disabled={!editable}
                      onChange={(e) => save.mutate({ id: p.id, patch: { active: e.target.checked } })}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
    </>
  )
}
