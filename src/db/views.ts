import { count, createLiveQueryCollection, eq, inArray, not, sum } from '@tanstack/react-db'
import { customersCollection, invoicesCollection, registerViews, tasksCollection } from './collections'

// Materialized views: live query collections defined once at module scope.
// They are maintained incrementally as the underlying collections change, can
// be shared by any number of components, and can themselves be queried/joined
// like any other collection ("queries over queries"). Re-visiting the
// dashboard reads them instantly instead of recomputing aggregates.
const KEEP = { gcTime: 10 * 60_000 }

export const customersByStatus = createLiveQueryCollection({
  id: 'view:customers-by-status',
  ...KEEP,
  query: (q) =>
    q
      .from({ c: customersCollection })
      .groupBy(({ c }) => c.status)
      .select(({ c }) => ({ status: c.status, customers: count(c.id), mrr: sum(c.mrr) })),
})

export const outstandingByStatus = createLiveQueryCollection({
  id: 'view:outstanding',
  ...KEEP,
  query: (q) =>
    q
      .from({ i: invoicesCollection })
      .where(({ i }) => inArray(i.status, ['open', 'overdue']))
      .groupBy(({ i }) => i.status)
      .select(({ i }) => ({ status: i.status, amount: sum(i.amount), n: count(i.id) })),
})

export const openTaskCount = createLiveQueryCollection({
  id: 'view:open-tasks',
  ...KEEP,
  query: (q) =>
    q
      .from({ t: tasksCollection })
      .where(({ t }) => not(eq(t.status, 'done')))
      .select(({ t }) => ({ n: count(t.id) }))
      .findOne(),
})

/** Paid revenue per month (all history); charts query this view with a range filter. */
export const revenueByMonth = createLiveQueryCollection({
  id: 'view:revenue-by-month',
  ...KEEP,
  query: (q) =>
    q
      .from({ i: invoicesCollection })
      .where(({ i }) => eq(i.status, 'paid'))
      .groupBy(({ i }) => i.paidMonth)
      .select(({ i }) => ({ month: i.paidMonth, revenue: sum(i.amount), invoices: count(i.id) })),
})

/** Signups per month per plan (all history). */
export const signupsByMonth = createLiveQueryCollection({
  id: 'view:signups-by-month',
  ...KEEP,
  query: (q) =>
    q
      .from({ c: customersCollection })
      .groupBy(({ c }) => [c.createdMonth, c.plan])
      .select(({ c }) => ({ month: c.createdMonth, plan: c.plan, count: count(c.id) })),
})

/** Active MRR per plan. */
export const mrrByPlan = createLiveQueryCollection({
  id: 'view:mrr-by-plan',
  ...KEEP,
  query: (q) =>
    q
      .from({ c: customersCollection })
      .where(({ c }) => eq(c.status, 'active'))
      .groupBy(({ c }) => c.plan)
      .select(({ c }) => ({ key: c.plan, value: sum(c.mrr) })),
})

// torn down before their sources on sign-in/out, so the next session recomputes them
registerViews(customersByStatus, outstandingByStatus, openTaskCount, revenueByMonth, signupsByMonth, mrrByPlan)
