import type {
  BreakdownPoint,
  CursorPage,
  ActivityEvent,
  OverviewMetrics,
  RevenuePoint,
  SignupPoint,
} from '../../shared/domain.ts'
import type { DB } from './schema.ts'

// Hand-written read models: cursor-paginated feed and server-side aggregates
// (what a "classic" API offers for dashboards).

const LIVE = 'deleted_at IS NULL'

export const events = {
  page: (db: DB, cursor: number | null, limit: number, type?: string): CursorPage<ActivityEvent> => {
    const clauses: string[] = []
    const params: unknown[] = []
    if (cursor) {
      clauses.push('id < ?')
      params.push(cursor)
    }
    if (type) {
      clauses.push('type LIKE ?')
      params.push(`${type}%`)
    }
    const rows = db
      .prepare(
        `SELECT id, type, substr(type, 1, instr(type, '.') - 1) AS category, actor_id AS "actorId", customer_id AS "customerId",
                message, created_at AS "createdAt"
         FROM events ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as ActivityEvent[]
    const hasMore = rows.length > limit
    const data = rows.slice(0, limit)
    return { data, nextCursor: hasMore ? data[data.length - 1]!.id : null }
  },
}

export const metrics = {
  overview: (db: DB): OverviewMetrics => {
    const c = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status = 'active' THEN mrr END), 0) AS mrr,
                SUM(status = 'active') AS active, SUM(status = 'trial') AS trial, SUM(status = 'churned') AS churned, COUNT(*) AS total
         FROM customers WHERE ${LIVE}`,
      )
      .get() as { mrr: number; active: number; trial: number; churned: number; total: number }
    const inv = db
      .prepare(
        `SELECT COALESCE(SUM(b.outstanding), 0) AS outstanding,
                (SELECT COUNT(*) FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status = 'overdue' AND c.${LIVE}) AS overdue
         FROM customer_balances b JOIN customers c ON c.id = b.customer_id WHERE c.${LIVE}`,
      )
      .get() as { outstanding: number; overdue: number }
    const t = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status != 'done'`).get() as { n: number }
    return {
      mrr: c.mrr,
      arr: c.mrr * 12,
      activeCustomers: c.active ?? 0,
      trialCustomers: c.trial ?? 0,
      churnedCustomers: c.churned ?? 0,
      totalCustomers: c.total,
      outstanding: inv.outstanding,
      overdueCount: inv.overdue ?? 0,
      openTasks: t.n,
      arpa: c.active ? Math.round(c.mrr / c.active) : 0,
    }
  },
  revenue: (db: DB, months: number): RevenuePoint[] =>
    (
      db
        .prepare(
          `SELECT substr(received_at, 1, 7) AS month, SUM(amount) AS revenue, COUNT(DISTINCT invoice_id) AS invoices
           FROM payments WHERE substr(received_at, 1, 7) < strftime('%Y-%m', 'now')
           GROUP BY month ORDER BY month DESC LIMIT ?`,
        )
        .all(months) as RevenuePoint[]
    ).reverse(),
  signups: (db: DB, months: number): SignupPoint[] =>
    db
      .prepare(
        `SELECT substr(created_at, 1, 7) AS month, plan, COUNT(*) AS count FROM customers
         WHERE ${LIVE} AND substr(created_at, 1, 7) >= (SELECT substr(date('now', ?), 1, 7))
         GROUP BY month, plan ORDER BY month`,
      )
      .all(`-${months - 1} months`) as SignupPoint[],
  breakdown: (db: DB, by: 'plan' | 'country' | 'status'): BreakdownPoint[] =>
    db
      .prepare(
        `SELECT ${by} AS key, COUNT(*) AS customers, COALESCE(SUM(CASE WHEN status = 'active' THEN mrr END), 0) AS mrr
         FROM customers WHERE ${LIVE} GROUP BY ${by} ORDER BY mrr DESC, customers DESC`,
      )
      .all() as BreakdownPoint[],
  workload: (db: DB) =>
    db
      .prepare(
        `SELECT u.id AS userId, u.name AS name, COALESCE(SUM(t.status != 'done'), 0) AS open, COALESCE(SUM(t.status = 'done'), 0) AS done
         FROM users u LEFT JOIN tasks t ON t.assignee_id = u.id GROUP BY u.id ORDER BY open DESC`,
      )
      .all() as Array<{ userId: number; name: string; open: number; done: number }>,
  arAging: (db: DB) =>
    db
      .prepare(
        `SELECT CASE
                  WHEN julianday('now') - julianday(i.due_at) <= 0 THEN 'current'
                  WHEN julianday('now') - julianday(i.due_at) <= 30 THEN '1-30'
                  WHEN julianday('now') - julianday(i.due_at) <= 60 THEN '31-60'
                  ELSE '60+'
                END AS bucket,
                COUNT(*) AS invoices,
                SUM(i.amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0)) AS amount
         FROM invoices i JOIN customers c ON c.id = i.customer_id
         WHERE i.status IN ('open', 'overdue') AND c.${LIVE}
         GROUP BY bucket`,
      )
      .all() as Array<{ bucket: string; invoices: number; amount: number }>,
}
