import type { RowSelectionState } from '@tanstack/react-table'
import { useCallback, useSyncExternalStore } from 'react'

// ----------------------------------------------------------------------------
// A tiny external store for table row selection that outlives paging, sorting,
// filtering and even leaving the page (component state would be reset by all
// of them). It belongs to the signed-in user: another user starts empty.
// ----------------------------------------------------------------------------

export function createSelectionStore() {
  let state: { userId: number | null; selection: RowSelectionState } = { userId: null, selection: {} }
  const listeners = new Set<() => void>()
  const NONE: RowSelectionState = {}
  return {
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    get: (userId: number) => (state.userId === userId ? state.selection : NONE),
    set: (userId: number, selection: RowSelectionState) => {
      // drop unselected keys so the store only ever holds selected ids
      const next = Object.fromEntries(Object.entries(selection).filter(([, v]) => v))
      state = { userId, selection: next }
      listeners.forEach((l) => l())
    },
  }
}

export type SelectionStore = ReturnType<typeof createSelectionStore>

/** Selected ids (as numbers) of a selection state. */
export const selectedIds = (s: RowSelectionState) =>
  Object.keys(s)
    .filter((k) => s[k])
    .map(Number)

export function useSelection(store: SelectionStore, userId: number) {
  const selection = useSyncExternalStore(store.subscribe, () => store.get(userId))
  const setSelection = useCallback((next: RowSelectionState) => store.set(userId, next), [store, userId])
  return [selection, setSelection] as const
}

/** The customers table's selection. */
export const customerSelection = createSelectionStore()
