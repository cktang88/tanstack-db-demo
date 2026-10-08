import { eq, useLiveQuery } from '@tanstack/react-db'
import { useEffect, useMemo } from 'react'
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
