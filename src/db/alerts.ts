import type { Customer } from '../../shared/domain'
import { money } from '../lib/format'
import { toast } from '../lib/toast'

// ----------------------------------------------------------------------------
// Live alerts: toast when a customer *becomes* churned or crosses $20k MRR,
// whoever made the change (this tab, another tab, the server).
//
// The customers collection is on-demand: it only holds the windows somebody is
// looking at, so a live query effect over "every churned customer" would have
// to load every churned customer first. Instead, every server version of a
// customer that reaches this client — pushed over SSE, or returned by our own
// write — is compared with the newest version we had before (the collection's
// synced row or the last one seen here, by updatedAt), and only transitions
// fire. Rows that merely load never do; the echo of a version already
// processed changes nothing.
// ----------------------------------------------------------------------------

/** $20k MRR, in cents */
export const BIG_ACCOUNT_MRR = 2_000_000

type CustomerState = Pick<Customer, 'id' | 'company' | 'status' | 'mrr'>
export type CustomerAlert = { kind: 'churned' | 'big-account'; customer: CustomerState }

const isChurned = (c: CustomerState) => c.status === 'churned'
const isBig = (c: CustomerState) => c.mrr > BIG_ACCOUNT_MRR

/** Alerts raised by a customer going from `before` to `after` (`before` undefined: a brand-new row). */
export function customerAlerts(before: CustomerState | undefined, after: CustomerState): CustomerAlert[] {
  const out: CustomerAlert[] = []
  if (isChurned(after) && !(before && isChurned(before))) out.push({ kind: 'churned', customer: after })
  if (isBig(after) && !(before && isBig(before))) out.push({ kind: 'big-account', customer: after })
  return out
}

export function showCustomerAlert({ kind, customer }: CustomerAlert) {
  if (kind === 'churned') toast.info(`⚠ ${customer.company} churned`, 'Detected from server changes')
  else toast.success(`🎉 ${customer.company} is now a $20k+ MRR account`, money(customer.mrr))
}

type Version = CustomerState & Pick<Customer, 'updatedAt'>
const pick = ({ id, company, status, mrr, updatedAt }: Version): Version => ({ id, company, status, mrr, updatedAt })
const newest = (a: Version | undefined, b: Version | undefined) => (!a ? b : !b ? a : b.updatedAt > a.updatedAt ? b : a)

/**
 * Detector for one signed-in session. `landed()` is called with each server
 * version of a customer before it is written into the collection, together
 * with the collection's synced row (if loaded).
 */
export function createCustomerAlerts(notify: (a: CustomerAlert) => void = showCustomerAlert) {
  /** the last server version of each customer processed here (for rows that are not loaded) */
  const seen = new Map<number, Version>()
  return {
    landed(after: Version, synced: Version | undefined, opts: { created?: boolean } = {}) {
      const before = newest(synced, seen.get(after.id))
      seen.set(after.id, pick(after))
      // never seen before (not loaded, or a row new to us): nothing to compare with
      if (!before && !opts.created) return
      for (const alert of customerAlerts(before, after)) notify(alert)
    },
    reset: () => seen.clear(),
  }
}

export const customerAlertsDetector = createCustomerAlerts()
