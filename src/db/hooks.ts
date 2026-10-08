import { eq, useLiveQuery } from '@tanstack/react-db'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Collection } from '@tanstack/react-db'
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
 * fallback loaded every overdue invoice, 2.7 MB). 10 s still loses it
 * occasionally (about 1 journey in 25 on the big database); the re-read after a
 * direct write deletes rows by itself, which no hold can prevent.
 */
export const WINDOW = { gcTime: 10_000 } as const

type WindowUtils = { setWindow?: (w: { offset: number; limit: number }) => true | Promise<void> }

/**
 * Paging an on-demand window. A new live query always loads its window from
 * the start of the source (TanStack DB trusts neither a remote offset nor a
 * cursor before its first request): page n of a fresh query is one request for
 * `limit=n*size`. An existing window moved with `setWindow` grows from the rows
 * it already has: the next page is one request for `offset=(n-1)*size&limit=size`.
 * Neither can jump: a window always holds every row before it.
 *
 * So the query is built at an anchor offset (`.offset(anchor)`) and stepping a
 * page moves its window; a jump forward (or back below the anchor) re-anchors,
 * which builds a new query and costs what a jump costs anyway.
 */
export function usePageAnchor(offset: number, limit: number) {
  const state = useRef({ anchor: offset, last: offset })
  const s = state.current
  if (offset !== s.last) {
    if (offset < s.anchor || offset - s.last > limit) s.anchor = offset
    s.last = offset
  }
  return s.anchor
}

/**
 * The rows of a paged window (see usePageAnchor): moves the live query's window
 * to `offset` with `setWindow` and, like useWindow, keeps the previous rows on
 * screen (dimmed) until the moved window is loaded.
 */
export function usePagedWindow<T extends object>(
  result: { data: T[] | undefined; isReady: boolean; collection?: Collection<any, any, any> },
  offset: number,
  limit: number,
) {
  const collection = result.collection
  // the window this collection currently shows (a new collection starts at offset 0)
  const [at, setAt] = useState<{ collection: unknown; offset: number; limit: number }>()
  const settled = at?.collection === collection && at?.offset === offset && at?.limit === limit
  useEffect(() => {
    if (!collection) return
    let cancelled = false
    void (async () => {
      for (;;) {
        if (cancelled) return
        // setWindow refuses while a load of this window is in flight: wait for it
        if (collection.status === 'ready') {
          try {
            const moved = (collection.utils as WindowUtils).setWindow?.({ offset, limit })
            if (moved && moved !== true) await moved
            if (!cancelled) setAt({ collection, offset, limit })
            return
          } catch (e) {
            if ((e as Error)?.name !== 'SetWindowReentrancyError') throw e
          }
        }
        await new Promise((r) => setTimeout(r, 25))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [collection, offset, limit])
  return useWindow({ data: result.data, isReady: result.isReady && settled })
}
