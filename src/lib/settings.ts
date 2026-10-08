import { useEffect, useSyncExternalStore } from 'react'

// Client-only UI preferences persisted to localStorage (and synced across tabs
// via the `storage` event). In the TanStack Query version this is hand-rolled.

export interface Settings {
  theme: 'light' | 'dark'
  compact: boolean
}

const KEY = 'saasly:settings'
const DEFAULTS: Settings = { theme: 'light', compact: false }

const listeners = new Set<() => void>()
let cache: Settings | null = null

function read(): Settings {
  if (cache) return cache
  try {
    cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    cache = DEFAULTS
  }
  return cache!
}

export function updateSettings(patch: Partial<Settings>) {
  cache = { ...read(), ...patch }
  localStorage.setItem(KEY, JSON.stringify(cache))
  listeners.forEach((l) => l())
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      cache = null
      listeners.forEach((l) => l())
    }
  })
}

export function useSettings() {
  const settings = useSyncExternalStore((cb) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }, read)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings.theme === 'dark')
  }, [settings.theme])
  return [settings, updateSettings] as const
}
