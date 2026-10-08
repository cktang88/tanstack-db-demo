import { useLiveQuery } from '@tanstack/react-db'
import { useQuery } from '@tanstack/react-query'
import { Badge, Card, PageHeader } from '../components/ui'
import { productAdoptionQuery } from '../db/aggregates'
import { productsCollection } from '../db/collections'
import { useCan } from '../lib/auth'
import { money, number } from '../lib/format'
import { toast } from '../lib/toast'

export function ProductsPage() {
  const { can } = useCan()
  // the catalog is a small eager collection (optimistic edits); adoption counts every live
  // subscription (hundreds of thousands at scale): a server aggregate, joined in by product id
  const { data: catalog } = useLiveQuery({ query: (q) => q.from({ p: productsCollection }).orderBy(({ p }) => p.id) })
  const { data: adoption } = useQuery(productAdoptionQuery())
  const products = catalog.map((p) => {
    const a = adoption?.get(p.id)
    return { ...p, $hasPendingWrites: p.$hasPendingWrites, subs: a?.subscriptions, units: a?.units, mrr: a?.mrr }
  })
  const editable = can('products:write')
  const save = (id: number, mutate: (d: { unitPrice: number; active: boolean }) => void) =>
    productsCollection
      .update(id, mutate)
      .when('settled')
      .then(
        () => toast.success('Product updated'),
        (e: Error) => toast.error('Could not update product — rolled back', e.message),
      )

  return (
    <>
      <PageHeader
        title="Products"
        description="Catalog (local, optimistic edits) ⨝ adoption across every subscription (server aggregate). Prices are locked into subscriptions at signup."
      />
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
            {products.map((p) => (
              <tr
                key={p.id}
                data-testid="product-row"
                className={p.$hasPendingWrites ? 'bg-amber-50/50 dark:bg-amber-500/5' : undefined}
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
                        if (cents !== p.unitPrice) void save(p.id, (d) => void (d.unitPrice = cents))
                      }}
                    />
                  ) : (
                    money(p.unitPrice)
                  )}
                </td>
                <td className="td text-right tabular-nums">{number(p.subs ?? 0)}</td>
                <td className="td text-right tabular-nums">{number(p.units ?? 0)}</td>
                <td className="td text-right tabular-nums">{money(p.mrr ?? 0)}</td>
                <td className="td">
                  <input
                    type="checkbox"
                    aria-label={`${p.sku} for sale`}
                    checked={p.active}
                    disabled={!editable}
                    onChange={(e) => save(p.id, (d) => void (d.active = e.target.checked))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  )
}
