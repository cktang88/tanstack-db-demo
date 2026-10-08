import { useQuery } from '@tanstack/react-query'
import { useEffect, useSyncExternalStore } from 'react'
import { meQuery } from './auth'

// Pinned accounts: client-only state persisted to localStorage and synced
// across tabs via the `storage` event (hand-rolled, like lib/settings.ts).

export interface Pin {
  id: number
  pinnedAt: string
}

const PINS = 'saasly:pins'
/**
 * Pins outlive sessions, so remember whose pins they are and drop them when a
 * different user signs in on this browser (preferences such as the theme are
 * per-browser and stay).
 */
const OWNER = 'saasly:client-state-owner'

interface Snapshot {
  owner: string | null
  pins: Pin[]
}

const EMPTY: Snapshot = { owner: null, pins: [] }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

const getItem = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
/** false when storage is unavailable (private mode, blocked): pins then live in memory only */
const setItem = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

const isPin = (p: unknown): p is Pin =>
  !!p && typeof p === 'object' && typeof (p as Pin).id === 'number' && typeof (p as Pin).pinnedAt === 'string'

export function parsePins(raw: string | null): Pin[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value.filter(isPin) : []
  } catch {
    return []
  }
}

// cached by the raw strings so useSyncExternalStore sees a stable snapshot
let cached: { pinsRaw: string | null; owner: string | null; snap: Snapshot } | null = null
let memory: string | null = null // used once localStorage refuses a write

function read(): Snapshot {
  const pinsRaw = memory ?? getItem(PINS)
  const owner = getItem(OWNER)
  if (cached && cached.pinsRaw === pinsRaw && cached.owner === owner) return cached.snap
  cached = { pinsRaw, owner, snap: { owner, pins: parsePins(pinsRaw) } }
  return cached.snap
}

function writePins(pins: Pin[]) {
  const raw = JSON.stringify(pins)
  memory = setItem(PINS, raw) ? null : raw
  emit()
}

export const pins = {
  list: () => read().pins,
  isPinned: (id: number) => read().pins.some((p) => p.id === id),
  pin: (id: number, pinnedAt = new Date().toISOString()) => {
    const current = read().pins.filter((p) => p.id !== id)
    writePins([...current, { id, pinnedAt }])
  },
  unpin: (id: number) => writePins(read().pins.filter((p) => p.id !== id)),
  toggle: (id: number) => (pins.isPinned(id) ? pins.unpin(id) : pins.pin(id)),
  clear: () => writePins([]),
}

/** Record who owns the client state; drop the pins if they belonged to someone else. */
export function claimClientState(userId: number) {
  const previous = getItem(OWNER)
  if (previous === String(userId)) return
  setItem(OWNER, String(userId))
  if (previous !== null) writePins([])
  else emit()
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === PINS || e.key === OWNER || e.key === null) emit()
  })
}

const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

/**
 * The signed-in user's pins, newest first. Pins recorded for another user are
 * hidden right away and cleared from storage after render.
 */
export function usePins(): Pin[] {
  const userId = useQuery(meQuery()).data?.user.id
  const snap = useSyncExternalStore(subscribe, read, () => EMPTY)
  useEffect(() => {
    if (userId !== undefined) claimClientState(userId)
  }, [userId])
  if (userId === undefined) return EMPTY.pins
  if (snap.owner !== null && snap.owner !== String(userId)) return EMPTY.pins
  return snap.pins
}

export const sortPins = (list: readonly Pin[]) => [...list].sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt) || b.id - a.id)

export function useIsPinned(id: number) {
  return usePins().some((p) => p.id === id)
}
