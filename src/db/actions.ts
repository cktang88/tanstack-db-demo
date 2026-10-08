import { createOptimisticAction, createTransaction } from '@tanstack/react-db'
import { PLAN_PRICE, type Customer } from '../../shared/domain'
import type { CustomerFormValues } from '../lib/validation'
import type { Product, Subscription } from '../../shared/domain'
import {
  customersCollection,
  eventsCollection,
  invoicesCollection,
  newId,
  paymentsCollection,
  persist,
  selectionCollection,
  subscriptionsCollection,
  tasksCollection,
  withCustomerDerived,
} from './collections'

// Intent-level mutations. Each one is a *transaction*: it can touch several
// collections, applies optimistically everywhere at once, persists in a single
// atomic request, and rolls back every collection together if that fails.

export const mrrOf = (c: Pick<Customer, 'plan' | 'seats' | 'status'>) =>
  c.status === 'active' ? PLAN_PRICE[c.plan] * c.seats : 0

/** Create a customer with a client-generated id — the row never changes key, so nothing flickers. */
export function createCustomer(values: CustomerFormValues) {
  const now = new Date().toISOString()
  const id = newId()
  const tx = customersCollection.insert(
    withCustomerDerived({ ...values, id, teamId: null, mrr: mrrOf(values), createdAt: now, updatedAt: now }),
  )
  return { id, tx }
}

/** Patch a customer; MRR is recomputed optimistically so KPIs/charts move instantly. */
export function updateCustomers(ids: number[], patch: Partial<CustomerFormValues>) {
  return customersCollection.update(ids, (drafts) => {
    for (const d of drafts) {
      Object.assign(d, patch)
      d.mrr = mrrOf(d)
      d.updatedAt = new Date().toISOString()
    }
  })
}

/**
 * Delete customers + their invoices + their row selection in ONE transaction
 * spanning three collections (server-backed, server-backed, local-only).
 */
export function deleteCustomers(ids: number[]) {
  const tx = createTransaction({
    mutationFn: async ({ transaction }) => {
      await persist(transaction.mutations)
      selectionCollection.utils.acceptMutations(transaction)
    },
  })
  tx.mutate(() => {
    customersCollection.delete(ids)
    const idSet = new Set(ids)
    const invoiceIds = invoicesCollection.toArray.filter((i) => idSet.has(i.customerId)).map((i) => i.id)
    if (invoiceIds.length) invoicesCollection.delete(invoiceIds, { metadata: { cascade: true } })
    const selected = ids.filter((id) => selectionCollection.has(id))
    if (selected.length) selectionCollection.delete(selected)
  })
  return tx
}

/**
 * "Mark paid" as an optimistic action: flips the invoice AND drops a
 * provisional activity event into the feed in the same instant. The server
 * then writes the real event, which replaces the provisional one.
 */
export const markInvoicePaid = createOptimisticAction<{ invoiceId: number; number: string; customerId: number }>({
  onMutate: ({ invoiceId, number, customerId }) => {
    const now = new Date().toISOString()
    invoicesCollection.update(invoiceId, (d) => {
      d.status = 'paid'
      d.paidAt = now
      d.paidMonth = now.slice(0, 7)
    })
    // provisional feed entry; `derived` = not sent, replaced by the server's real event
    eventsCollection.insert(
      {
        id: -newId(),
        type: 'invoice.paid',
        category: 'invoice',
        actorId: null,
        customerId,
        message: `Invoice ${number} marked paid`,
        createdAt: now,
      },
      { metadata: { derived: true } },
    )
  },
  mutationFn: async (_vars, { transaction }) => {
    await persist(transaction.mutations)
    // land the server's canonical event before the provisional one is dropped
    await eventsCollection.utils.refetch()
  },
})

/**
 * Staged bulk reassignment: changes are applied to the UI immediately as a
 * preview (workload chart, task lists…) but nothing is sent until commit().
 * rollback() discards the preview.
 */
export function stageReassignment(fromUserId: number, toUserId: number | null) {
  const tx = createTransaction({
    autoCommit: false,
    mutationFn: async ({ transaction }) => persist(transaction.mutations),
  })
  const ids = tasksCollection.toArray.filter((t) => t.assigneeId === fromUserId && t.status !== 'done').map((t) => t.id)
  if (ids.length)
    tx.mutate(() =>
      tasksCollection.update(ids, (drafts) => {
        for (const d of drafts) d.assigneeId = toUserId
      }),
    )
  return { tx, count: ids.length }
}

/**
 * Append a payment to the (append-only, on-demand) ledger. If it covers the
 * remainder, the invoice flips to "paid" optimistically — a *derived* change
 * the server computes itself (DB trigger), so it is re-read after commit
 * instead of being sent.
 */
export const recordPayment = createOptimisticAction<{
  invoiceId: number
  customerId: number
  amount: number
  remaining: number
  method: 'card' | 'ach' | 'wire'
  userId: number
}>({
  onMutate: ({ invoiceId, customerId, amount, remaining, method, userId }) => {
    const now = new Date().toISOString()
    paymentsCollection.insert({
      id: newId(),
      invoiceId,
      customerId,
      amount,
      method,
      reference: 'pending…',
      receivedAt: now,
      recordedBy: userId,
    })
    if (amount >= remaining)
      invoicesCollection.update(invoiceId, { metadata: { derived: true } }, (d) => {
        d.status = 'paid'
        d.paidAt = now
        d.paidMonth = now.slice(0, 7)
      })
  },
  mutationFn: async (_vars, { transaction }) => persist(transaction.mutations),
})

/** Add an add-on: the subscription row is sent; the customer's MRR is predicted locally and re-read. */
export function addAddon(customerId: number, product: Product, quantity: number) {
  const tx = createTransaction({ mutationFn: async ({ transaction }) => persist(transaction.mutations) })
  tx.mutate(() => {
    subscriptionsCollection.insert({
      id: newId(),
      customerId,
      productId: product.id,
      quantity,
      unitPrice: product.unitPrice,
      status: 'active',
      startedAt: new Date().toISOString(),
      canceledAt: null,
    })
    customersCollection.update(customerId, { metadata: { derived: true } }, (d) => void (d.mrr += quantity * product.unitPrice))
  })
  return tx
}

export function cancelSubscription(sub: Subscription) {
  const tx = createTransaction({ mutationFn: async ({ transaction }) => persist(transaction.mutations) })
  tx.mutate(() => {
    subscriptionsCollection.update(sub.id, (d) => {
      d.status = 'canceled'
      d.canceledAt = new Date().toISOString()
    })
    if (sub.status === 'active' || sub.status === 'past_due')
      customersCollection.update(
        sub.customerId,
        { metadata: { derived: true } },
        (d) => void (d.mrr -= sub.quantity * sub.unitPrice),
      )
  })
  return tx
}
