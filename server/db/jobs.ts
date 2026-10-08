import type { DB } from './schema.ts'

/**
 * Mark open invoices past their due date as overdue (archived customers' are
 * left alone). Returns the changed invoices so callers can publish them.
 */
export function markOverdue(db: DB, now = new Date()) {
  return db
    .prepare(
      `UPDATE invoices SET status = 'overdue'
       WHERE status = 'open' AND due_at < ? AND customer_id NOT IN (SELECT id FROM customers WHERE deleted_at IS NOT NULL)
       RETURNING id, customer_id AS customerId`,
    )
    .all(now.toISOString()) as Array<{ id: number; customerId: number }>
}

/**
 * Rebuild the monthly MRR rollup from the append-only MRR movements ledger.
 * A customer's MRR at time T is the new_mrr of their last movement before T,
 * so history is never rewritten by later seat or plan changes. Per customer
 * and month: start = MRR at the month's start, end = MRR at its end;
 *   new customers / new MRR       start = 0 and end > 0 (new or reactivated)
 *   churned customers / churned   start > 0 and end = 0
 * (expansion and contraction live in the ledger itself). Trials have no MRR
 * until they convert, so they count from their conversion month.
 */
export function rebuildMrrSnapshots(db: DB, months = 18, now = new Date()) {
  const monthEnds: Array<{ month: string; end: string; start: string }> = []
  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1))
    monthEnds.push({ month: start.toISOString().slice(0, 7), start: start.toISOString(), end: end.toISOString() })
  }
  const month = db.prepare(`
    WITH x AS (
      SELECT c.customer_id,
        COALESCE((SELECT m.new_mrr FROM mrr_movements m WHERE m.customer_id = c.customer_id AND m.at < @start
                  ORDER BY m.at DESC, m.id DESC LIMIT 1), 0) AS s,
        COALESCE((SELECT m.new_mrr FROM mrr_movements m WHERE m.customer_id = c.customer_id AND m.at < @end
                  ORDER BY m.at DESC, m.id DESC LIMIT 1), 0) AS e
      FROM (SELECT DISTINCT customer_id FROM mrr_movements WHERE at < @end) c
    )
    SELECT COALESCE(SUM(e), 0) AS mrr,
           COALESCE(SUM(e > 0), 0) AS active,
           COALESCE(SUM(s = 0 AND e > 0), 0) AS newC,
           COALESCE(SUM(CASE WHEN s = 0 AND e > 0 THEN e ELSE 0 END), 0) AS newMrr,
           COALESCE(SUM(s > 0 AND e = 0), 0) AS churnC,
           COALESCE(SUM(CASE WHEN s > 0 AND e = 0 THEN s ELSE 0 END), 0) AS churnMrr
    FROM x`)
  const upsert = db.prepare(`
    INSERT INTO mrr_snapshots (month, mrr, active_customers, new_customers, churned_customers, new_mrr, churned_mrr, computed_at)
    VALUES (@month, @mrr, @active, @newC, @churnC, @newMrr, @churnMrr, @at)
    ON CONFLICT(month) DO UPDATE SET mrr = excluded.mrr, active_customers = excluded.active_customers,
      new_customers = excluded.new_customers, churned_customers = excluded.churned_customers,
      new_mrr = excluded.new_mrr, churned_mrr = excluded.churned_mrr, computed_at = excluded.computed_at`)
  const at = new Date().toISOString()
  db.transaction(() => {
    for (const m of monthEnds) {
      const r = month.get({ start: m.start, end: m.end }) as {
        mrr: number
        active: number
        newC: number
        newMrr: number
        churnC: number
        churnMrr: number
      }
      upsert.run({ month: m.month, ...r, at })
    }
  })()
  return monthEnds.length
}
