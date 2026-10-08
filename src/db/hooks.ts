import { eq, useLiveQuery } from '@tanstack/react-db'
import { useEffect, useMemo, useState } from 'react'
import { DEFAULT_PREFS, prefsCollection, usersCollection, type Prefs } from './collections'

/** Preferences live in a localStorage collection: reactive, persisted, cross-tab synced — no custom store. */
export function usePrefs() {
  const { data } = useLiveQuery({
    query: (q) =>
      q
        .from({ p: prefsCollection })
        .where(({ p }) => eq(p.id, 'prefs'))
        .findOne(),
  })
  const prefs: Prefs = data ?? DEFAULT_PREFS
  useEffect(() => {
    document.documentElement.classList.toggle('dark', prefs.theme === 'dark')
  }, [prefs.theme])
  return [prefs, updatePrefs] as const
}

export function updatePrefs(patch: Partial<Omit<Prefs, 'id'>>) {
  if (prefsCollection.has('prefs')) prefsCollection.update('prefs', (d) => void Object.assign(d, patch))
  else prefsCollection.insert({ ...DEFAULT_PREFS, ...patch })
}

/** All users keyed by id, live. */
export function useUsersById() {
  const { data } = useLiveQuery({ query: (q) => q.from({ u: usersCollection }) })
  return useMemo(() => new Map(data.map((u) => [u.id, u])), [data])
}

/**
 * The rows of an on-demand window, keeping the previous window on screen
 * (dimmed) while the next one loads instead of flashing an empty table.
 */
export function useWindow<T>(result: { data: T[] | undefined; isReady: boolean }) {
  const [shown, setShown] = useState<T[]>([])
  const current = result.data ?? shown
  if (result.isReady && current !== shown) setShown(current)
  return { rows: result.isReady ? current : shown, isPlaceholder: !result.isReady }
}

/**
 * Live-query options for EVERY live query over an on-demand collection. A
 * query stays subscribed for a few seconds after the UI moved on (another
 * window, another page), so rows that the next query already shows from local
 * state are not garbage-collected from under it before its own request lands:
 * the query collection drops a subset's rows as soon as nothing holds it, and
 * TanStack DB treats the removal of rows an ordered window already showed as
 * an ordering change it can only repair by loading every match (a where-only,
 * unbounded request). Navigating from a customer's page to the billing ledger
 * hits exactly that (their payments are in both), so this is not only for list
 * windows. It also makes going back instant.
 *
 * The cost: a held query is still an *active* subset, and every direct write
 * into an on-demand collection (persist, the SSE feed) makes query-db-collection
 * re-read all of its active subsets, held ones included. A shorter hold (3 s)
 * cut that work by a fifth but lost the race again on the big database (the
 * fallback loaded every overdue invoice, 2.7 MB), so correctness wins here.
 */
export const WINDOW = { gcTime: 10_000 } as const
