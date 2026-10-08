import {
  eq,
  sum,
  count,
  throttleStrategy,
  useLiveQuery,
  useLiveSuspenseQuery,
  usePacedMutations,
  and,
  inArray,
} from '@tanstack/react-db'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { CustomerForm } from '../components/CustomerForm'
import { Avatar, Badge, Card, Dialog, Empty, PageHeader, Stat } from '../components/ui'
import { deleteCustomers, markInvoicePaid, mrrOf, updateCustomers } from '../db/actions'
import {
  customersCollection,
  eventsCollection,
  invoicesCollection,
  persist,
  pinsCollection,
  usersCollection,
} from '../db/collections'
import { date, money, relative } from '../lib/format'
import { toast } from '../lib/toast'
import { customerDetailRoute } from '../router'

export function CustomerDetailPage() {
  const { customerId } = customerDetailRoute.useParams()
  // Suspense-friendly live query; a join gives us the owner in the same row.
  const { data } = useLiveSuspenseQuery({
    query: (q) =>
      q
        .from({ c: customersCollection })
        .leftJoin({ u: usersCollection }, ({ c, u }) => eq(c.ownerId, u.id))
        .where(({ c }) => eq(c.id, customerId))
        .findOne(),
  })
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
  if (!data)
    return (
      <div className="card mx-auto mt-10 max-w-md p-6 text-center" role="alert">
        <div className="text-lg font-semibold">Not found</div>
        <p className="mt-2 text-sm text-zinc-500">Customer {customerId} does not exist (or was just deleted).</p>
        <Link to="/customers" className="btn-secondary mt-4">
          Back to customers
        </Link>
      </div>
    )
  const { c: customer, u: owner } = data

  return (
    <>
      <PageHeader
        title={customer.company}
        description={
          <>
            <Link to="/customers" className="text-brand-600 hover:underline">
              Customers
            </Link>{' '}
            / {customer.name} · {customer.email}
          </>
        }
        actions={
          <>
            <PinButton customerId={customer.id} />
            <button className="btn-secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              className="btn-danger"
              onClick={() => {
                if (!confirm(`Delete ${customer.company}?`)) return
                deleteCustomers([customer.id])
                  .when('settled')
                  .catch((e: Error) => toast.error('Delete failed — restored', e.message))
                void navigate({ to: '/customers' })
              }}
            >
              Delete
            </button>
          </>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Plan"
          value={<Badge value={customer.plan} />}
          hint={<SeatsSlider id={customer.id} seats={customer.seats} />}
        />
        <Stat label="Status" value={<Badge value={customer.status} />} hint={`since ${date(customer.createdAt)}`} />
        <Stat label="MRR" value={money(customer.mrr)} testId="customer-mrr" />
        <Stat
          label="Owner"
          value={
            owner ? (
              <span className="flex items-center gap-2 text-base">
                <Avatar name={owner.name} color={owner.avatarColor} /> {owner.name}
              </span>
            ) : (
              '—'
            )
          }
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <CustomerInvoices customerId={customerId} />
        <CustomerActivity customerId={customerId} />
      </div>
      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit customer">
        <CustomerForm
          initial={customer}
          submitLabel="Save changes"
          onSubmit={async (patch) => {
            updateCustomers([customer.id], patch)
              .when('settled')
              .catch((e: Error) => toast.error('Update failed — changes rolled back', e.message))
          }}
          onDone={() => setEditing(false)}
        />
      </Dialog>
    </>
  )
}

/**
 * Paced mutation: drag the slider and every tick updates MRR everywhere
 * (this page, KPIs, charts, tables) instantly, while the server receives at
 * most one write per 500ms.
 */
function SeatsSlider({ id, seats }: { id: number; seats: number }) {
  const setSeats = usePacedMutations<number>({
    onMutate: (n) =>
      customersCollection.update(id, (d) => {
        d.seats = n
        d.mrr = mrrOf(d)
      }),
    mutationFn: async ({ transaction }) => persist(transaction.mutations),
    strategy: throttleStrategy({ wait: 500, trailing: true }),
  })
  return (
    <label className="flex items-center gap-2">
      <input
        type="range"
        min={1}
        max={300}
        value={seats}
        aria-label="Seats"
        onChange={(e) => setSeats(Number(e.target.value))}
        className="w-28 accent-brand-600"
      />
      <span className="tabular-nums" data-testid="seats-value">
        {seats} seats
      </span>
    </label>
  )
}

function PinButton({ customerId }: { customerId: number }) {
  const { data: pin } = useLiveQuery({
    query: (q) =>
      q
        .from({ p: pinsCollection })
        .where(({ p }) => eq(p.id, customerId))
        .findOne(),
  })
  return (
    <button
      className="btn-secondary"
      aria-pressed={!!pin}
      onClick={() =>
        pin ? pinsCollection.delete(customerId) : pinsCollection.insert({ id: customerId, pinnedAt: new Date().toISOString() })
      }
    >
      {pin ? '★ Pinned' : '☆ Pin'}
    </button>
  )
}

function CustomerInvoices({ customerId }: { customerId: number }) {
  // Uses the customerId index — no per-customer endpoint, no cache key.
  const { data: invoices } = useLiveQuery({
    query: (q) =>
      q
        .from({ i: invoicesCollection })
        .where(({ i }) => eq(i.customerId, customerId))
        .orderBy(({ i }) => i.issuedAt, 'desc'),
  })
  const { data: totals } = useLiveQuery({
    query: (q) =>
      q
        .from({ i: invoicesCollection })
        .where(({ i }) => and(eq(i.customerId, customerId), inArray(i.status, ['open', 'overdue'])))
        .select(({ i }) => ({ outstanding: sum(i.amount), n: count(i.id) }))
        .findOne(),
  })
  const lifetime = invoices.filter((i) => i.status === 'paid').reduce((s, i) => s + i.amount, 0)
  return (
    <Card
      title={`Invoices (${invoices.length})`}
      actions={
        <span className="text-xs text-zinc-500" data-testid="invoice-totals">
          Lifetime {money(lifetime)} · Outstanding {money(totals?.outstanding ?? 0)}
        </span>
      }
    >
      {invoices.length === 0 ? (
        <Empty>No invoices yet.</Empty>
      ) : (
        <table className="w-full" data-testid="customer-invoices">
          <thead>
            <tr>
              <th className="th">Number</th>
              <th className="th">Issued</th>
              <th className="th">Status</th>
              <th className="th text-right">Amount</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {invoices.map((i) => (
              <tr key={i.id}>
                <td className="td font-mono text-xs">{i.number}</td>
                <td className="td">{date(i.issuedAt)}</td>
                <td className="td">
                  <Badge value={i.status} />
                  {i.$hasPendingWrites && <span className="ml-2 text-xs text-amber-600">saving…</span>}
                </td>
                <td className="td text-right tabular-nums">{money(i.amount)}</td>
                <td className="td text-right">
                  {(i.status === 'open' || i.status === 'overdue') && (
                    <button
                      className="btn-ghost px-2 py-0.5 text-xs"
                      onClick={() =>
                        markInvoicePaid({ invoiceId: i.id, number: i.number, customerId })
                          .when('settled')
                          .catch((e: Error) => toast.error('Could not mark invoice paid — rolled back', e.message))
                      }
                    >
                      Mark paid
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function CustomerActivity({ customerId }: { customerId: number }) {
  // On-demand: pushes `customerId[eq]=…&sort=-id&limit=20` to the API.
  const { data, isLoading } = useLiveQuery({
    query: (q) =>
      q
        .from({ e: eventsCollection })
        .where(({ e }) => eq(e.customerId, customerId))
        // ids are monotonic, so a single unique sort key keeps pushed-down windows exact & cheap
        .orderBy(({ e }) => e.id, 'desc')
        .limit(20),
  })
  return (
    <Card title="Recent activity">
      {isLoading ? (
        <div className="h-40 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800" />
      ) : data.length === 0 ? (
        <Empty>No activity.</Empty>
      ) : (
        <ul className="space-y-3 text-sm" data-testid="customer-activity">
          {data.map((e) => (
            <li key={e.id} className={e.$hasPendingWrites ? 'opacity-60' : undefined}>
              <div>{e.message}</div>
              <div className="text-xs text-zinc-400">{relative(e.createdAt)}</div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
