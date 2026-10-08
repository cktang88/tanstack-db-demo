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
import { Fragment, useMemo, useState, type FormEvent } from 'react'
import { CustomerForm } from '../components/CustomerForm'
import { Avatar, Badge, Card, Dialog, Empty, PageHeader, Stat } from '../components/ui'
import {
  addAddon,
  applyBillingPatch,
  cancelSubscription,
  deleteCustomers,
  markInvoicePaid,
  recordPayment,
  updateCustomers,
} from '../db/actions'
import { useCan } from '../lib/auth'
import { DailyChart } from '../components/charts'
import { PAYMENT_METHODS } from '../../shared/domain'
import {
  contactsCollection,
  customerHealthCollection,
  customerTagsCollection,
  customersCollection,
  eventsCollection,
  invoicesCollection,
  lineItemsCollection,
  newId,
  paymentsCollection,
  productsCollection,
  subscriptionsCollection,
  tagsCollection,
  usageDailyCollection,
  type InvoiceRow,
  persist,
  pinsCollection,
  usersCollection,
} from '../db/collections'
import { date, field, money, number, relative } from '../lib/format'
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
  const { can, canEditCustomer, privileged } = useCan()
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
  const editable = canEditCustomer(customer)

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
            {!editable && <span className="text-xs text-zinc-500">read-only — owned by {owner?.name ?? 'nobody'}</span>}
            <PinButton customerId={customer.id} />
            <button className="btn-secondary" onClick={() => setEditing(true)} disabled={!editable}>
              Edit
            </button>
            {can('customers:delete') && (
              <button
                className="btn-danger"
                onClick={() => {
                  if (!confirm(`Archive ${customer.company}? Subscriptions will be canceled; billing history is kept.`)) return
                  deleteCustomers([customer.id])
                    .when('settled')
                    .catch((e: Error) => toast.error('Archive failed — restored', e.message))
                  void navigate({ to: '/customers' })
                }}
              >
                Archive
              </button>
            )}
          </>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat
          label="Plan"
          value={<Badge value={customer.plan} />}
          hint={
            editable ? (
              <SeatsSlider id={customer.id} seats={customer.seats} pending={!!customer.$hasPendingWrites} />
            ) : (
              `${customer.seats} seats`
            )
          }
        />
        <HealthStat customerId={customer.id} status={customer.status} />
        <Stat label="MRR" value={money(customer.mrr)} hint="Σ active subscriptions" testId="customer-mrr" />
        <BalanceStat customerId={customer.id} />
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
      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Subscriptions customerId={customer.id} churned={customer.status === 'churned'} seats={customer.seats} />
        <Contacts customerId={customer.id} editable={editable} />
        <Tags customerId={customer.id} editable={editable} />
      </div>
      <Card className="mb-6" title="API usage (daily rollup, on-demand)">
        <Usage customerId={customer.id} />
      </Card>
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <CustomerInvoices customerId={customerId} />
        <CustomerActivity customerId={customerId} />
      </div>
      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit customer">
        <CustomerForm
          canAssignOwner={privileged}
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
function SeatsSlider({ id, seats, pending }: { id: number; seats: number; pending: boolean }) {
  const setSeats = usePacedMutations<number>({
    // MRR moves by the base plan's sold price (see predictMrr); the server's value is read back on save
    onMutate: (n) => customersCollection.update(id, (d) => applyBillingPatch(d, { seats: n })),
    mutationFn: async ({ transaction }) => persist(transaction.mutations),
    strategy: throttleStrategy({ wait: 500, trailing: true }),
  })
  return (
    <label className="flex items-center gap-2">
      <input
        type="range"
        min={1}
        // never clamp a large account to the slider's range
        max={Math.max(300, seats * 2)}
        value={seats}
        aria-label="Seats"
        onChange={(e) => setSeats(Number(e.target.value))}
        className="w-28 accent-brand-600"
      />
      <span className="tabular-nums" data-testid="seats-value">
        {seats} seats
      </span>
      {/* `base` = the authoritative synced row, without optimistic writes layered on top */}
      {pending && (
        <span className="text-xs text-amber-600" data-testid="seats-saved">
          saved: {customersCollection.base.get(id)?.seats ?? '—'}
        </span>
      )}
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
  const [open, setOpen] = useState<number | null>(null)
  const canPay = useCan().can('billing:write')
  return (
    <Card
      title={`Invoices (${invoices.length})`}
      actions={
        <span className="text-xs text-zinc-500" data-testid="invoice-totals">
          Lifetime {money(lifetime)} · Open invoices {money(totals?.outstanding ?? 0)} (before payments)
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
              <Fragment key={i.id}>
                <tr
                  className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                  onClick={() => setOpen(open === i.id ? null : i.id)}
                >
                  <td className="td font-mono text-xs">
                    {open === i.id ? '▾' : '▸'} {i.number}
                  </td>
                  <td className="td">{date(i.issuedAt)}</td>
                  <td className="td">
                    <Badge value={i.status} />
                    {i.$hasPendingWrites && <span className="ml-2 text-xs text-amber-600">saving…</span>}
                  </td>
                  <td className="td text-right tabular-nums">{money(i.amount)}</td>
                  <td className="td text-right" onClick={(e) => e.stopPropagation()}>
                    {canPay && (i.status === 'open' || i.status === 'overdue') && (
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
                {open === i.id && (
                  <tr>
                    <td colSpan={5} className="bg-zinc-50 px-3 py-3 dark:bg-zinc-900/60">
                      <InvoiceDetail invoice={i} />
                    </td>
                  </tr>
                )}
              </Fragment>
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

/** Status + health: health comes from a SQL view (on-demand, one row pushed down by customerId). */
function HealthStat({ customerId, status }: { customerId: number; status: string }) {
  const { data: health } = useLiveQuery({
    query: (q) =>
      q
        .from({ h: customerHealthCollection })
        .where(({ h }) => eq(h.customerId, customerId))
        .findOne(),
  })
  const tone = { healthy: 'green', at_risk: 'red', dormant: 'amber', churned: 'zinc' } as const
  return (
    <Stat
      label="Status"
      testId="customer-health"
      value={
        <span className="flex items-center gap-2">
          <Badge value={status} />
          {health && <Badge value={health.health} tone={tone[health.health]} />}
        </span>
      }
      hint={health ? `${number(health.apiCalls30d)} API calls / 30d` : '—'}
    />
  )
}

/**
 * Replaces the server's customer_balances rollup with two live aggregates:
 * invoices (eager) and this customer's slice of the payment ledger (on-demand,
 * pushed down as customerId[eq]=…). An optimistic payment moves the balance at once.
 */
function BalanceStat({ customerId }: { customerId: number }) {
  const { data: invoiced } = useLiveQuery({
    query: (q) =>
      q
        .from({ i: invoicesCollection })
        .where(({ i }) => eq(i.customerId, customerId))
        .groupBy(({ i }) => i.status)
        .select(({ i }) => ({ status: i.status, amount: sum(i.amount) })),
  })
  const { data: partial } = useLiveQuery({
    query: (q) =>
      q
        .from({ p: paymentsCollection })
        .where(({ p }) => eq(p.customerId, customerId))
        // compound join condition (db 0.12): same invoice AND same customer
        .innerJoin({ i: invoicesCollection }, ({ p, i }) => and(eq(p.invoiceId, i.id), eq(p.customerId, i.customerId)))
        .where(({ i }) => inArray(i.status, ['open', 'overdue']))
        .select(({ p }) => ({ paid: sum(p.amount) }))
        .findOne(),
  })
  const by = (s: string) => invoiced.find((r) => r.status === s)?.amount ?? 0
  return (
    <Stat
      label="Balance"
      testId="customer-balance"
      value={<span data-testid="balance-value">{money(by('open') + by('overdue') - (partial?.paid ?? 0))}</span>}
      hint={`open invoices net of partial payments · ${money(by('overdue'))} overdue (gross) · ${money(by('paid'))} paid lifetime`}
    />
  )
}

function Subscriptions({ customerId, churned, seats }: { customerId: number; churned: boolean; seats: number }) {
  const { can } = useCan()
  const { data: subs } = useLiveQuery({
    query: (q) =>
      q
        .from({ s: subscriptionsCollection })
        .innerJoin({ p: productsCollection }, ({ s, p }) => eq(s.productId, p.id))
        .where(({ s }) => eq(s.customerId, customerId))
        .orderBy(({ s }) => s.id)
        .select(({ s, p }) => ({ ...s, productName: p.name, kind: p.kind })),
  })
  const { data: addons } = useLiveQuery({
    query: (q) =>
      q
        .from({ p: productsCollection })
        .where(({ p }) => and(eq(p.kind, 'addon'), eq(p.active, true)))
        .orderBy(({ p }) => p.id),
  })
  const live = subs.filter((s) => s.status !== 'canceled')
  const fail = (e: Error) => toast.error('Subscription change failed — rolled back', e.message)
  return (
    <Card title={`Subscriptions (${live.length} live)`}>
      <ul className="space-y-2 text-sm" data-testid="subscriptions">
        {subs.map((s) => (
          <li
            key={s.id}
            className={`flex items-center justify-between gap-2 ${s.status === 'canceled' ? 'opacity-50' : ''} ${s.$hasPendingWrites ? 'animate-pulse' : ''}`}
          >
            <span className="min-w-0 truncate">
              {s.productName} <span className="text-xs text-zinc-500">× {s.quantity}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="text-xs tabular-nums">{money(s.quantity * s.unitPrice)}</span>
              <Badge value={s.status} />
              {can('billing:write') && s.status !== 'canceled' && s.kind === 'addon' && (
                <button
                  className="text-xs text-zinc-400 hover:text-red-600"
                  aria-label={`Cancel subscription #${s.id}`}
                  onClick={() => cancelSubscription(s).when('settled').catch(fail)}
                >
                  ✕
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {can('billing:write') && !churned && (
        <form
          className="mt-3 flex gap-2"
          action={(f) => {
            const product = addons.find((p) => p.id === Number(field(f, 'productId')))
            if (product)
              addAddon(customerId, product, Number(field(f, 'quantity')))
                .when('settled')
                .then(() => toast.success('Add-on added'), fail)
          }}
        >
          <select name="productId" className="input" aria-label="Add-on">
            {addons.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input name="quantity" type="number" min={1} defaultValue={seats} className="input w-20" aria-label="Quantity" />
          <button className="btn-secondary">Add</button>
        </form>
      )}
    </Card>
  )
}

function Contacts({ customerId, editable }: { customerId: number; editable: boolean }) {
  const { data: contacts } = useLiveQuery({
    query: (q) =>
      q
        .from({ c: contactsCollection })
        .where(({ c }) => eq(c.customerId, customerId))
        .orderBy(({ c }) => c.isPrimary, 'desc')
        .orderBy(({ c }) => c.name),
  })
  // controlled + onSubmit (a form action would reset the inputs) so a rejected entry stays editable
  const empty = { name: '', email: '', title: '' }
  const [draft, setDraft] = useState(empty)
  const [error, setError] = useState<string | null>(null)
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }))
  const add = (e: FormEvent) => {
    e.preventDefault()
    const name = draft.name.trim()
    const email = draft.email.trim()
    if (name.length < 2 || !email.includes('@')) return setError('Name and a valid email are required')
    contactsCollection
      .insert({
        id: newId(),
        customerId,
        name,
        email,
        title: draft.title.trim() || 'Contact',
        isPrimary: false,
        createdAt: new Date().toISOString(),
      })
      .when('settled')
      .catch((e: Error) => toast.error('Could not add contact — removed', e.message))
    setDraft(empty)
    setError(null)
  }
  return (
    <Card title={`Contacts (${contacts.length})`}>
      <ul className="space-y-2 text-sm" data-testid="contacts">
        {contacts.map((c) => (
          <li key={c.id} className={`flex items-center justify-between gap-2 ${c.$hasPendingWrites ? 'opacity-60' : ''}`}>
            <span className="min-w-0">
              <span className="font-medium">{c.name}</span> {c.isPrimary && <Badge value="primary" tone="violet" />}
              <div className="truncate text-xs text-zinc-500">
                {c.title} · {c.email}
              </div>
            </span>
            {editable && !c.isPrimary && (
              <button
                className="text-xs text-zinc-400 hover:text-red-600"
                aria-label={`Remove ${c.name}`}
                onClick={() =>
                  contactsCollection
                    .delete(c.id)
                    .when('settled')
                    .catch((e: Error) => toast.error('Could not remove contact', e.message))
                }
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form onSubmit={add} className="mt-3 grid grid-cols-2 gap-2">
          <input
            name="name"
            className="input"
            placeholder="Name"
            aria-label="Contact name"
            value={draft.name}
            onChange={set('name')}
          />
          <input
            name="email"
            className="input"
            placeholder="Email"
            aria-label="Contact email"
            value={draft.email}
            onChange={set('email')}
          />
          <input
            name="title"
            className="input"
            placeholder="Title"
            aria-label="Contact title"
            value={draft.title}
            onChange={set('title')}
          />
          <button className="btn-secondary">Add contact</button>
          {error && <p className="col-span-2 text-xs text-red-600">{error}</p>}
        </form>
      )}
    </Card>
  )
}

function Tags({ customerId, editable }: { customerId: number; editable: boolean }) {
  // many-to-many: tags LEFT JOIN customer_tags (for this customer) -> "applied" flag per tag
  const { data: tags } = useLiveQuery({
    query: (q) => {
      const mine = q.from({ ct: customerTagsCollection }).where(({ ct }) => eq(ct.customerId, customerId))
      return q
        .from({ t: tagsCollection })
        .leftJoin({ ct: mine }, ({ t, ct }) => eq(t.id, ct.tagId))
        .orderBy(({ t }) => t.name)
        .select(({ t, ct }) => ({ ...t, linkId: ct?.id }))
    },
  })
  const toggle = (t: { id: number; linkId?: string }) => {
    const tx = t.linkId
      ? customerTagsCollection.delete(t.linkId)
      : customerTagsCollection.insert({
          id: `${customerId}:${t.id}`,
          customerId,
          tagId: t.id,
          taggedAt: new Date().toISOString(),
        })
    tx.when('settled').catch((e: Error) => toast.error('Could not change tag — rolled back', e.message))
  }
  return (
    <Card title="Tags">
      <div className="flex flex-wrap gap-2" data-testid="tags">
        {tags.map((t) => {
          const on = !!t.linkId
          return (
            <button
              key={t.id}
              disabled={!editable}
              aria-pressed={on}
              onClick={() => toggle(t)}
              className={`rounded-full border px-2 py-0.5 text-xs ${on ? 'text-white' : 'text-zinc-500'} disabled:cursor-default`}
              style={on ? { background: t.color, borderColor: t.color } : { borderColor: t.color }}
            >
              {t.name}
            </button>
          )
        })}
      </div>
    </Card>
  )
}

function Usage({ customerId }: { customerId: number }) {
  // on-demand: pushes customerId[eq]=…&metric[eq]=api_calls&sort=day
  const { data, isLoading } = useLiveQuery({
    query: (q) =>
      q
        .from({ u: usageDailyCollection })
        .where(({ u }) => and(eq(u.customerId, customerId), eq(u.metric, 'api_calls')))
        .orderBy(({ u }) => u.day),
  })
  const series = useMemo(() => data.map((d) => ({ day: d.day, value: d.quantity })), [data])
  return (
    <div data-testid="usage" data-state={isLoading ? 'loading' : 'ready'}>
      {isLoading ? (
        <div className="h-48 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-800" />
      ) : series.length ? (
        <DailyChart data={series} label="API calls per day" />
      ) : (
        <Empty>No metered usage.</Empty>
      )}
    </div>
  )
}

function InvoiceDetail({ invoice }: { invoice: InvoiceRow }) {
  const { me, can } = useCan()
  // both on-demand: immutable line items and the append-only ledger, fetched for this invoice only
  const { data: lines } = useLiveQuery({
    query: (q) =>
      q
        .from({ l: lineItemsCollection })
        .where(({ l }) => eq(l.invoiceId, invoice.id))
        .orderBy(({ l }) => l.id),
  })
  const { data: payments } = useLiveQuery({
    query: (q) =>
      q
        .from({ p: paymentsCollection })
        .where(({ p }) => eq(p.invoiceId, invoice.id))
        .orderBy(({ p }) => p.id),
  })
  const paid = payments.reduce((s, p) => s + p.amount, 0)
  const remaining = invoice.amount - paid
  const open = invoice.status === 'open' || invoice.status === 'overdue'
  const fail = (e: Error) => toast.error('Billing change failed — rolled back', e.message)
  return (
    <div className="grid gap-4 text-sm md:grid-cols-2" data-testid="invoice-detail">
      <div>
        <div className="label">Line items</div>
        <ul className="space-y-1">
          {lines.map((l) => (
            <li key={l.id} className="flex justify-between gap-2">
              <span className="truncate">
                {l.description} <span className="text-xs text-zinc-500">× {l.quantity}</span>
              </span>
              <span className="tabular-nums">{money(l.amount)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <div className="label">
          Payments (ledger) — {money(paid)} of {money(invoice.amount)}
        </div>
        <ul className="space-y-1" data-testid="invoice-payments">
          {payments.map((p) => (
            <li key={p.id} className={`flex justify-between gap-2 ${p.$hasPendingWrites ? 'opacity-60' : ''}`}>
              <span>
                {date(p.receivedAt)} · <Badge value={p.method} tone="zinc" /> {/* the reference is generated by the server */}
                <span className="font-mono text-xs">{p.reference || 'pending…'}</span>
              </span>
              <span className="tabular-nums">{money(p.amount)}</span>
            </li>
          ))}
          {payments.length === 0 && <li className="text-zinc-500">No payments yet</li>}
        </ul>
        {can('billing:write') && open && (
          <form
            className="mt-3 flex flex-wrap gap-2"
            action={(f) => {
              const amount = Math.round(Number(field(f, 'amount')) * 100) || remaining
              recordPayment({
                invoiceId: invoice.id,
                customerId: invoice.customerId,
                amount,
                remaining,
                method: field(f, 'method') as 'card',
                userId: me.user.id,
              })
                .when('settled')
                .catch(fail)
            }}
          >
            <input
              name="amount"
              type="number"
              step="0.01"
              min="0.01"
              className="input w-28"
              placeholder={String(remaining / 100)}
              aria-label="Payment amount"
            />
            <select name="method" className="input w-24" aria-label="Payment method">
              {PAYMENT_METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <button className="btn-secondary">Record payment</button>
            {/* the server refuses (409) to void an invoice that already has payments */}
            {payments.length === 0 && (
              <button
                type="button"
                className="btn-ghost text-red-600"
                onClick={() =>
                  invoicesCollection
                    .update(invoice.id, (d) => void (d.status = 'void'))
                    .when('settled')
                    .catch(fail)
                }
              >
                Void
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  )
}
