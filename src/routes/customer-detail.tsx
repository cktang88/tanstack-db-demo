import { field } from '../lib/format'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Fragment, Suspense, useActionState, useMemo, useState } from 'react'
import { PAYMENT_METHODS, type Customer, type Invoice } from '../../shared/domain'
import { DailyChart } from '../components/charts'
import { CustomerForm } from '../components/CustomerForm'
import { Avatar, Badge, Card, Dialog, Empty, PageHeader, Skeleton, Stat } from '../components/ui'
import { useCan } from '../lib/auth'
import { date, money, number, relative } from '../lib/format'
import {
  useAddContact,
  useAddSubscription,
  useDeleteContact,
  useDeleteCustomers,
  useMarkInvoicePaid,
  useRecordPayment,
  useTagCustomer,
  useUntagCustomer,
  useUpdateCustomer,
  useUpdateSubscription,
  useVoidInvoice,
} from '../lib/mutations'
import {
  customerActivityQuery,
  customerBalanceQuery,
  customerContactsQuery,
  customerHealthQuery,
  customerInvoicesQuery,
  customerQuery,
  customerSubscriptionsQuery,
  customerTagsQuery,
  customerUsageQuery,
  invoiceLineItemsQuery,
  invoicePaymentsQuery,
  productsQuery,
  tagsQuery,
  usersQuery,
} from '../lib/queries'
import { customerDetailRoute } from '../router'

const HEALTH_TONE = { healthy: 'green', at_risk: 'red', dormant: 'amber', churned: 'zinc' } as const

export function CustomerDetailPage() {
  const { customerId } = customerDetailRoute.useParams()
  const { data: customer } = useSuspenseQuery(customerQuery(customerId))
  const { data: users = [] } = useQuery(usersQuery())
  const { data: balance } = useQuery(customerBalanceQuery(customerId))
  const { data: health } = useQuery(customerHealthQuery(customerId))
  const { can, canEditCustomer, privileged } = useCan()
  const owner = users.find((u) => u.id === customer.ownerId)
  const update = useUpdateCustomer(customerId)
  const del = useDeleteCustomers()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)
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
            <button className="btn-secondary" onClick={() => setEditing(true)} disabled={!editable}>
              Edit
            </button>
            {can('customers:delete') && editable && (
              <button
                className="btn-danger"
                onClick={() => {
                  if (!confirm(`Archive ${customer.company}? Subscriptions will be canceled; billing history is kept.`)) return
                  del.mutate([customer.id])
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
        <Stat label="Plan" value={<Badge value={customer.plan} />} hint={`${customer.seats} seats`} />
        <Stat
          label="Status"
          value={
            <span className="flex items-center gap-2">
              <Badge value={customer.status} />
              {health && <Badge value={health.health} tone={HEALTH_TONE[health.health]} />}
            </span>
          }
          hint={health ? `${number(health.apiCalls30d)} API calls / 30d` : `since ${date(customer.createdAt)}`}
          testId="customer-health"
        />
        <Stat label="MRR" value={money(customer.mrr)} hint="Σ active subscriptions" testId="customer-mrr" />
        <Stat
          label="Balance"
          value={money(balance?.outstanding ?? 0)}
          hint={balance ? `${money(balance.overdue)} overdue · ${money(balance.paid)} paid lifetime` : 'no invoices'}
          testId="customer-balance"
        />
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
        <Subscriptions customer={customer} />
        <Contacts customerId={customerId} editable={editable} />
        <Tags customerId={customerId} editable={editable} />
      </div>
      <Card className="mb-6" title="API usage (daily rollup)">
        <Usage customerId={customerId} />
      </Card>
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Suspense fallback={<Skeleton className="h-64" />}>
          <CustomerInvoices customerId={customerId} />
        </Suspense>
        <CustomerActivity customerId={customerId} />
      </div>
      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit customer">
        <CustomerForm
          initial={customer}
          canAssignOwner={privileged}
          submitLabel="Save changes"
          onSubmit={(patch) => update.mutateAsync({ id: customer.id, patch })}
          onDone={() => setEditing(false)}
        />
      </Dialog>
    </>
  )
}

function Subscriptions({ customer }: { customer: Customer }) {
  const { data: subs = [] } = useQuery(customerSubscriptionsQuery(customer.id))
  const { data: products = [] } = useQuery(productsQuery())
  const { can } = useCan()
  const add = useAddSubscription()
  const change = useUpdateSubscription()
  const byId = new Map(products.map((p) => [p.id, p]))
  const live = subs.filter((s) => s.status !== 'canceled')
  const addons = products.filter((p) => p.kind === 'addon' && p.active)
  return (
    <Card title={`Subscriptions (${live.length} live)`}>
      <ul className="space-y-2 text-sm" data-testid="subscriptions">
        {subs.map((s) => (
          <li key={s.id} className={`flex items-center justify-between gap-2 ${s.status === 'canceled' ? 'opacity-50' : ''}`}>
            <span className="min-w-0 truncate">
              {byId.get(s.productId)?.name ?? `#${s.productId}`} <span className="text-xs text-zinc-500">× {s.quantity}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="text-xs tabular-nums">{money(s.quantity * s.unitPrice)}</span>
              <Badge value={s.status} />
              {can('billing:write') && s.status !== 'canceled' && byId.get(s.productId)?.kind === 'addon' && (
                <button
                  className="text-xs text-zinc-400 hover:text-red-600"
                  aria-label="Cancel add-on"
                  onClick={() => change.mutate({ id: s.id, patch: { status: 'canceled' } })}
                >
                  ✕
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {can('billing:write') && customer.status !== 'churned' && (
        <form
          className="mt-3 flex gap-2"
          action={(f) =>
            add.mutate({ customerId: customer.id, productId: Number(f.get('productId')), quantity: Number(f.get('quantity')) })
          }
        >
          <select name="productId" className="input" aria-label="Add-on">
            {addons.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            name="quantity"
            type="number"
            min={1}
            defaultValue={customer.seats}
            className="input w-20"
            aria-label="Quantity"
          />
          <button className="btn-secondary">Add</button>
        </form>
      )}
    </Card>
  )
}

function Contacts({ customerId, editable }: { customerId: number; editable: boolean }) {
  const { data: contacts = [] } = useQuery(customerContactsQuery(customerId))
  const add = useAddContact()
  const remove = useDeleteContact()
  // keep what was typed when the server rejects it (React resets the form after the action)
  type ContactDraft = { name: string; email: string; title: string }
  const blank: ContactDraft = { name: '', email: '', title: '' }
  const [{ error, draft }, action] = useActionState(
    async (_: { error: string | null; draft: ContactDraft }, f: FormData) => {
      const draft = { name: field(f, 'name').trim(), email: field(f, 'email').trim(), title: field(f, 'title').trim() }
      try {
        await add.mutateAsync({ customerId, ...draft, title: draft.title || 'Contact', isPrimary: false })
        return { error: null, draft: blank }
      } catch (e) {
        return { error: (e as Error).message, draft }
      }
    },
    { error: null, draft: blank },
  )
  return (
    <Card title={`Contacts (${contacts.length})`}>
      <ul className="space-y-2 text-sm" data-testid="contacts">
        {contacts.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2">
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
                onClick={() => remove.mutate(c.id)}
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <form action={action} className="mt-3 grid grid-cols-2 gap-2">
          <input name="name" className="input" placeholder="Name" aria-label="Contact name" defaultValue={draft.name} />
          <input name="email" className="input" placeholder="Email" aria-label="Contact email" defaultValue={draft.email} />
          <input name="title" className="input" placeholder="Title" aria-label="Contact title" defaultValue={draft.title} />
          <button className="btn-secondary">Add contact</button>
          {error && <p className="col-span-2 text-xs text-red-600">{error}</p>}
        </form>
      )}
    </Card>
  )
}

function Tags({ customerId, editable }: { customerId: number; editable: boolean }) {
  const { data: tags = [] } = useQuery(tagsQuery())
  const { data: links = [] } = useQuery(customerTagsQuery(customerId))
  const tag = useTagCustomer()
  const untag = useUntagCustomer()
  const applied = new Set(links.map((l) => l.tagId))
  return (
    <Card title="Tags">
      <div className="flex flex-wrap gap-2" data-testid="tags">
        {tags.map((t) => {
          const on = applied.has(t.id)
          return (
            <button
              key={t.id}
              disabled={!editable}
              aria-pressed={on}
              onClick={() => (on ? untag.mutate(`${customerId}:${t.id}`) : tag.mutate({ customerId, tagId: t.id }))}
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
  const { data = [], isPending } = useQuery(customerUsageQuery(customerId))
  const series = useMemo(() => data.map((d) => ({ day: d.day, value: d.quantity })), [data])
  if (isPending) return <Skeleton className="h-48" />
  if (!series.length) return <Empty>No metered usage.</Empty>
  return <DailyChart data={series} label="API calls per day" />
}

function CustomerInvoices({ customerId }: { customerId: number }) {
  const { data: invoices } = useSuspenseQuery(customerInvoicesQuery(customerId))
  const [open, setOpen] = useState<number | null>(null)
  const markPaid = useMarkInvoicePaid()
  const { can } = useCan()
  const outstanding = invoices.filter((i) => i.status === 'open' || i.status === 'overdue').reduce((s, i) => s + i.amount, 0)
  const lifetime = invoices.filter((i) => i.status === 'paid').reduce((s, i) => s + i.amount, 0)
  return (
    <Card
      title={`Invoices (${invoices.length})`}
      actions={
        <span className="text-xs text-zinc-500">
          Lifetime {money(lifetime)} · Outstanding {money(outstanding)}
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
                  </td>
                  <td className="td text-right tabular-nums">{money(i.amount)}</td>
                  <td className="td text-right" onClick={(e) => e.stopPropagation()}>
                    {can('billing:write') && (i.status === 'open' || i.status === 'overdue') && (
                      <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => markPaid.mutate(i.id)}>
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

function InvoiceDetail({ invoice }: { invoice: Invoice }) {
  const { data: lines = [] } = useQuery(invoiceLineItemsQuery(invoice.id))
  const { data: payments = [] } = useQuery(invoicePaymentsQuery(invoice.id))
  const pay = useRecordPayment()
  const voidIt = useVoidInvoice()
  const { can } = useCan()
  const paid = payments.reduce((s, p) => s + p.amount, 0)
  const open = invoice.status === 'open' || invoice.status === 'overdue'
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
            <li key={p.id} className="flex justify-between gap-2">
              <span>
                {date(p.receivedAt)} · <Badge value={p.method} tone="zinc" />{' '}
                <span className="font-mono text-xs">{p.reference}</span>
              </span>
              <span className="tabular-nums">{money(p.amount)}</span>
            </li>
          ))}
          {payments.length === 0 && <li className="text-zinc-500">No payments yet</li>}
        </ul>
        {can('billing:write') && open && (
          <form
            className="mt-3 flex flex-wrap gap-2"
            action={(f) =>
              pay.mutate({
                invoiceId: invoice.id,
                amount: Math.round(Number(f.get('amount')) * 100) || undefined,
                method: f.get('method') as 'card',
              })
            }
          >
            <input
              name="amount"
              type="number"
              step="0.01"
              min="0.01"
              className="input w-28"
              placeholder={(invoice.amount - paid) / 100 + ''}
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
              <button type="button" className="btn-ghost text-red-600" onClick={() => voidIt.mutate(invoice.id)}>
                Void
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  )
}

function CustomerActivity({ customerId }: { customerId: number }) {
  const { data = [], isPending } = useQuery(customerActivityQuery(customerId))
  return (
    <Card title="Recent activity">
      {isPending ? (
        <Skeleton className="h-40" />
      ) : data.length === 0 ? (
        <Empty>No activity.</Empty>
      ) : (
        <ul className="space-y-3 text-sm">
          {data.map((e) => (
            <li key={e.id}>
              <div>{e.message}</div>
              <div className="text-xs text-zinc-400">{relative(e.createdAt)}</div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
