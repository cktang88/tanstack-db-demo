import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Suspense, useState } from 'react'
import { CustomerForm } from '../components/CustomerForm'
import { Avatar, Badge, Card, Dialog, Empty, PageHeader, Skeleton, Stat } from '../components/ui'
import { date, money, relative } from '../lib/format'
import { useDeleteCustomers, useMarkInvoicePaid, useUpdateCustomer } from '../lib/mutations'
import { customerActivityQuery, customerInvoicesQuery, customerQuery, usersQuery } from '../lib/queries'
import { customerDetailRoute } from '../router'

export function CustomerDetailPage() {
  const { customerId } = customerDetailRoute.useParams()
  const { data: customer } = useSuspenseQuery(customerQuery(customerId))
  const { data: users = [] } = useQuery(usersQuery())
  const owner = users.find((u) => u.id === customer.ownerId)
  const update = useUpdateCustomer()
  const del = useDeleteCustomers()
  const navigate = useNavigate()
  const [editing, setEditing] = useState(false)

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
            <button className="btn-secondary" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              className="btn-danger"
              onClick={() => {
                if (!confirm(`Delete ${customer.company}?`)) return
                del.mutate([customer.id])
                void navigate({ to: '/customers' })
              }}
            >
              Delete
            </button>
          </>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Plan" value={<Badge value={customer.plan} />} hint={`${customer.seats} seats`} />
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
        <Suspense fallback={<Skeleton className="h-64" />}>
          <CustomerInvoices customerId={customerId} />
        </Suspense>
        <CustomerActivity customerId={customerId} />
      </div>
      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit customer">
        <CustomerForm
          initial={customer}
          submitLabel="Save changes"
          onSubmit={(patch) => update.mutateAsync({ id: customer.id, patch })}
          onDone={() => setEditing(false)}
        />
      </Dialog>
    </>
  )
}

function CustomerInvoices({ customerId }: { customerId: number }) {
  const { data: invoices } = useSuspenseQuery(customerInvoicesQuery(customerId))
  const markPaid = useMarkInvoicePaid()
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
              <tr key={i.id}>
                <td className="td font-mono text-xs">{i.number}</td>
                <td className="td">{date(i.issuedAt)}</td>
                <td className="td">
                  <Badge value={i.status} />
                </td>
                <td className="td text-right tabular-nums">{money(i.amount)}</td>
                <td className="td text-right">
                  {(i.status === 'open' || i.status === 'overdue') && (
                    <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => markPaid.mutate(i.id)}>
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
