import type { DB } from './schema.ts'

/** Mark open invoices past their due date as overdue. Returns affected count. */
export function markOverdue(db: DB, now = new Date()) {
  return db.prepare(`UPDATE invoices SET status = 'overdue' WHERE status = 'open' AND due_at < ?`).run(now.toISOString()).changes
}

/**
 * Rebuild the monthly MRR rollup from subscription history. A subscription
 * contributes to month M if it started on/before the end of M and was not
 * canceled before the end of M.
 */
export function rebuildMrrSnapshots(db: DB, months = 18, now = new Date()) {
  const monthEnds: Array<{ month: string; end: string; start: string }> = []
  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1))
    monthEnds.push({ month: start.toISOString().slice(0, 7), start: start.toISOString(), end: end.toISOString() })
  }
  const active = db.prepare(`
    SELECT COALESCE(SUM(s.quantity * s.unit_price), 0) AS mrr, COUNT(DISTINCT s.customer_id) AS customers
    FROM subscriptions s
    WHERE s.status != 'trialing' AND s.started_at < @end AND (s.canceled_at IS NULL OR s.canceled_at >= @end)`)
  const fresh = db.prepare(`
    SELECT COALESCE(SUM(s.quantity * s.unit_price), 0) AS mrr, COUNT(DISTINCT s.customer_id) AS customers
    FROM subscriptions s WHERE s.status != 'trialing' AND s.started_at >= @start AND s.started_at < @end`)
  const churned = db.prepare(`
    SELECT COALESCE(SUM(s.quantity * s.unit_price), 0) AS mrr, COUNT(DISTINCT s.customer_id) AS customers
    FROM subscriptions s WHERE s.canceled_at >= @start AND s.canceled_at < @end`)
  const upsert = db.prepare(`
    INSERT INTO mrr_snapshots (month, mrr, active_customers, new_customers, churned_customers, new_mrr, churned_mrr, computed_at)
    VALUES (@month, @mrr, @active, @newC, @churnC, @newMrr, @churnMrr, @at)
    ON CONFLICT(month) DO UPDATE SET mrr = excluded.mrr, active_customers = excluded.active_customers,
      new_customers = excluded.new_customers, churned_customers = excluded.churned_customers,
      new_mrr = excluded.new_mrr, churned_mrr = excluded.churned_mrr, computed_at = excluded.computed_at`)
  const at = new Date().toISOString()
  db.transaction(() => {
    for (const m of monthEnds) {
      const a = active.get(m) as { mrr: number; customers: number }
      const n = fresh.get(m) as { mrr: number; customers: number }
      const c = churned.get(m) as { mrr: number; customers: number }
      upsert.run({
        month: m.month,
        mrr: a.mrr,
        active: a.customers,
        newC: n.customers,
        churnC: c.customers,
        newMrr: n.mrr,
        churnMrr: c.mrr,
        at,
      })
    }
  })()
  return monthEnds.length
}
