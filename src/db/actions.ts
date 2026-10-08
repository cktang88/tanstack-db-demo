import { createOptimisticAction, createTransaction } from '@tanstack/react-db'
import { PLAN_PRICE, type ActivityEvent, type Customer, type Page } from '../../shared/domain'
import type { CustomerFormValues } from '../lib/validation'
import type { Product, Subscription } from '../../shared/domain'
import { api } from '../lib/api'
import {
  customersCollection,
  eventsCollection,
  invoicesCollection,
  isSyncing,
  newId,
  notificationsCollection,
  paymentsCollection,
  persist,
  productsCollection,
  rederiveCustomer,
  rederiveInvoice,
  selectionCollection,
  subscriptionsCollection,
  tasksCollection,
  withCustomerDerived,
  type CustomerRow,
} from './collections'
import { applyChange } from './live'

// Intent-level mutations. Each one is a *transaction*: it can touch several
// collections, applies optimistically everywhere at once, persists in a single
// atomic request, and rolls back every collection together if that fails.

/** List-price MRR of a brand-new account (no add-ons, no negotiated prices yet). */
export const mrrOf = (c: Pick<Customer, 'plan' | 'seats' | 'status'>) =>
  c.status === 'active' ? PLAN_PRICE[c.plan] * c.seats : 0

type Billing = Pick<Customer, 'id' | 'plan' | 'seats' | 'status' | 'mrr'>

/**
 * Optimistic MRR after a plan/seats/status change. The server's MRR is
 * Σ quantity × unit_price over the account's active/past-due subscriptions
 * (base plan at its *sold* price + add-ons), and editing the customer only
 * changes the base-plan subscription — so predict exactly that when the
 * account's subscriptions are loaded (subscriptions are on-demand: the detail
 * page loads them), and otherwise move the known MRR by the base-plan delta.
 * The real value is read back after commit either way.
 */
export function predictMrr(before: Billing, next: Pick<Customer, 'plan' | 'seats' | 'status'>) {
  // trial -> subscriptions are "trialing", churned -> canceled: neither counts
  if (next.status !== 'active') return 0
  const live =
    productsCollection.status === 'ready'
      ? subscriptionsCollection.toArray.filter((s) => s.customerId === before.id && s.status !== 'canceled')
      : []
  const kind = (s: Subscription) => productsCollection.get(s.productId)
  const base = live.filter((s) => kind(s)?.kind === 'plan').sort((a, b) => b.id - a.id)[0]
  if (base) {
    const addons = live.filter((s) => kind(s)?.kind === 'addon').reduce((sum, s) => sum + s.quantity * s.unitPrice, 0)
    // same plan keeps its sold price; a plan change starts a new subscription at list price
    const unitPrice = base && kind(base)?.planCode === next.plan ? base.unitPrice : PLAN_PRICE[next.plan]
    return addons + next.seats * unitPrice
  }
  if (before.status === 'active' && before.plan === next.plan)
    return before.mrr + (next.seats - before.seats) * PLAN_PRICE[next.plan]
  return mrrOf(next)
}

/** Apply a plan/seats/status patch to a customer draft, moving MRR with it. */
export function applyBillingPatch(d: Billing, patch: Partial<Pick<Customer, 'plan' | 'seats' | 'status'>>) {
  const before = { id: d.id, plan: d.plan, seats: d.seats, status: d.status, mrr: d.mrr }
  Object.assign(d, patch)
  if (before.plan !== d.plan || before.seats !== d.seats || before.status !== d.status) d.mrr = predictMrr(before, d)
  // sort keys / search text follow the optimistic values (e.g. the row moves in an MRR-sorted window)
  if ('order' in d) rederiveCustomer(d as CustomerRow)
}

/** Create a customer with a client-generated id — the row never changes key, so nothing flickers. */
export function createCustomer(values: CustomerFormValues) {
  const now = new Date().toISOString()
  const id = newId()
  const tx = customersCollection.insert(
    withCustomerDerived({ ...values, id, teamId: null, mrr: mrrOf(values), createdAt: now, updatedAt: now }),
  )
  return { id, tx }
}

/**
 * Patch customers; MRR is predicted optimistically so KPIs/charts move
 * instantly (it is server-computed, so it isn't sent — see toBatchOps).
 */
export function updateCustomers(ids: number[], patch: Partial<CustomerFormValues>) {
  return customersCollection.update(ids, (drafts) => {
    for (const d of drafts) {
      const { plan, seats, status, ...rest } = patch
      Object.assign(d, rest)
      applyBillingPatch(d, {
        ...(plan !== undefined && { plan }),
        ...(seats !== undefined && { seats }),
        ...(status !== undefined && { status }),
      })
      d.updatedAt = new Date().toISOString()
      rederiveCustomer(d)
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
      rederiveInvoice(d)
    })
    // provisional feed entry; `derived` = not sent, replaced by the server's real event.
    // A positive (client-generated, larger than any server id) key sorts it at the head.
    eventsCollection.insert(
      {
        id: newId(),
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
  mutationFn: async ({ customerId }, { transaction }) => {
    await persist(transaction.mutations)
    // land the server's canonical event before the provisional one is dropped
    await landLatestEvent(customerId)
  },
})

/**
 * Read the newest event for a customer and write it like an SSE change would
 * (same guards and fan-out). Refetching the events collection instead would
 * re-read every window it holds. Best effort: the change feed delivers it too.
 */
async function landLatestEvent(customerId: number) {
  try {
    const page = await api.get<Page<ActivityEvent>>('/events', { 'customerId[eq]': customerId, sort: '-id', limit: 1 })
    const row = page.data[0]
    if (row) await applyChange({ kind: 'upsert', entity: 'events', row })
  } catch (e) {
    console.error('[markInvoicePaid] could not read back the activity event', e)
  }
}

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
      // generated by the server (never sent, see toBatchOps); the UI shows "pending…" until then
      reference: '',
      receivedAt: now,
      recordedBy: userId,
    })
    if (amount >= remaining)
      invoicesCollection.update(invoiceId, { metadata: { derived: true } }, (d) => {
        d.status = 'paid'
        d.paidAt = now
        rederiveInvoice(d)
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
    customersCollection.update(customerId, { metadata: { derived: true } }, (d) => {
      d.mrr += quantity * product.unitPrice
      rederiveCustomer(d)
    })
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
      customersCollection.update(sub.customerId, { metadata: { derived: true } }, (d) => {
        d.mrr -= sub.quantity * sub.unitPrice
        rederiveCustomer(d)
      })
  })
  return tx
}

/**
 * Mark every unread notification read — all of them, not just the rows a
 * list happens to show. The collection holds all of the user's
 * notifications, so the optimistic patch covers everything; the server does
 * the same in one statement (POST /notifications/read-all) rather than a
 * batch of per-row updates.
 */
export const markAllNotificationsRead = createOptimisticAction<void>({
  onMutate: () => {
    const now = new Date().toISOString()
    const ids = notificationsCollection.toArray.filter((n) => !n.readAt).map((n) => n.id)
    if (ids.length) notificationsCollection.update(ids, (drafts) => drafts.forEach((d) => (d.readAt = now)))
  },
  mutationFn: async () => {
    await api.post('/notifications/read-all', {})
    // land the server's read_at values before the optimistic ones are dropped (one request)
    if (isSyncing(notificationsCollection)) await notificationsCollection.utils.refetch()
  },
})
