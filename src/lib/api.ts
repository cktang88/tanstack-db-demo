import type { ApiError } from '../../shared/domain'

export class HttpError extends Error {
  readonly status: number
  readonly body: ApiError | undefined
  constructor(status: number, body: ApiError | undefined) {
    super(body?.message ?? `Request failed with status ${status}`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

type Primitive = string | number | boolean | null | undefined
export type QueryParams = Record<string, Primitive | Primitive[]>

export function toSearch(params: QueryParams = {}): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) {
      const vals = v.filter((x) => x !== undefined && x !== null && x !== '')
      if (vals.length) sp.set(k, vals.join(','))
    } else sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

let unauthorized: ((e: HttpError) => void) | undefined
/** Called for every 401 except a failed sign-in: the session expired or was revoked. */
export function onUnauthorized(fn: (e: HttpError) => void) {
  unauthorized = fn
}

async function request<T>(
  method: string,
  path: string,
  opts: { params?: QueryParams; body?: unknown; signal?: AbortSignal } = {},
) {
  const res = await fetch(`/api${path}${toSearch(opts.params)}`, {
    method,
    signal: opts.signal,
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as ApiError | undefined
    const error = new HttpError(res.status, body)
    if (res.status === 401 && path !== '/auth/login') unauthorized?.(error)
    throw error
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string, params?: QueryParams, signal?: AbortSignal) => request<T>('GET', path, { params, signal }),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, { body }),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, { body }),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, { body }),
  delete: <T = void>(path: string) => request<T>('DELETE', path),
}
