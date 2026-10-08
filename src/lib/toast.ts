import { useSyncExternalStore } from 'react'

export interface Toast {
  id: number
  kind: 'success' | 'error' | 'info'
  title: string
  description?: string
}

let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function push(kind: Toast['kind'], title: string, description?: string) {
  const id = nextId++
  toasts = [...toasts, { id, kind, title, description }].slice(-4)
  emit()
  setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3500)
  return id
}

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emit()
}

export const toast = {
  success: (title: string, description?: string) => push('success', title, description),
  error: (title: string, description?: string) => push('error', title, description),
  info: (title: string, description?: string) => push('info', title, description),
}

export function useToasts() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => toasts,
  )
}
