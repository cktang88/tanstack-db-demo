import { queryOptions, useMutation, useQueryClient, useSuspenseQuery, type QueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import type { Me, Permission, Role } from '../../shared/domain'
import { resetServerCollections } from '../db/collections'
import { stopLiveSync } from '../db/live'
import { api, HttpError } from './api'

export const meQuery = () =>
  queryOptions({
    queryKey: ['auth', 'me'],
    queryFn: ({ signal }) => api.get<Me>('/auth/me', undefined, signal),
    staleTime: 5 * 60_000,
    retry: false,
  })

export const demoUsersQuery = () =>
  queryOptions({
    queryKey: ['auth', 'demo-users'],
    queryFn: () =>
      api.get<Array<{ email: string; name: string; role: Role; title: string; password: string }>>('/auth/demo-users'),
    staleTime: Infinity,
  })

export const isUnauthorized = (e: unknown) => e instanceof HttpError && e.status === 401

/** Current session (suspends; only used inside the authenticated layout). */
export function useMe() {
  return useSuspenseQuery(meQuery()).data
}

type ProjectAccess = { teamId: number | null; ownerId: number | null }

export function useCan() {
  const me = useMe()
  const privileged = me.user.role === 'owner' || me.user.role === 'admin'
  /** row-level rule mirrored from the server: members may only edit projects they own or that belong to one of their teams */
  const canEditProject = (p: ProjectAccess) =>
    me.permissions.includes('projects:write') &&
    (privileged || p.ownerId === me.user.id || (p.teamId !== null && me.teamIds.includes(p.teamId)))
  return {
    me,
    can: (p: Permission) => me.permissions.includes(p),
    /** row-level rule mirrored from the server: members may only edit customers they own */
    canEditCustomer: (c: { ownerId: number | null }) =>
      me.permissions.includes('customers:write') && (privileged || c.ownerId === me.user.id),
    canEditProject,
    /** tasks: project editors, plus the task's assignee (server: tasks.canWrite) */
    canEditTask: (p: ProjectAccess | undefined, t: { assigneeId: number | null }) =>
      (!!p && canEditProject(p)) || (me.permissions.includes('projects:write') && t.assigneeId === me.user.id),
    privileged,
  }
}

/**
 * Forget the current session on this client: close the per-user change feed,
 * drop every server-backed collection (and the views over them) and the cached
 * identity, so route guards ask the server again. Used on sign-in, sign-out
 * and when any request comes back 401.
 */
export async function clearSession(qc: QueryClient) {
  stopLiveSync()
  await resetServerCollections()
  qc.removeQueries({ queryKey: ['auth'] })
}

/** Only same-origin, absolute paths are followed after sign-in. */
export const safeRedirect = (r: unknown) =>
  typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') && !r.startsWith('/login') ? r : '/'

export function useLogin(opts: { redirect?: string } = {}) {
  const qc = useQueryClient()
  const router = useRouter()
  return useMutation({
    mutationFn: (creds: { email: string; password: string }) => api.post<Me & { token: string }>('/auth/login', creds),
    onSuccess: async ({ token: _token, ...me }) => {
      // never leak another user's rows: drop every collection, then sync fresh as the new user
      await clearSession(qc)
      qc.setQueryData(meQuery().queryKey, me)
      // the app route's guard opens the change feed for this user
      const redirectTo = opts.redirect ?? (router.state.location.search as { redirect?: unknown }).redirect
      await router.navigate({ href: safeRedirect(redirectTo), replace: true })
    },
  })
}

export function useLogout() {
  const qc = useQueryClient()
  const router = useRouter()
  return useMutation({
    mutationFn: () => api.post('/auth/logout', {}),
    onSettled: async () => {
      await clearSession(qc)
      await router.navigate({ to: '/login' })
    },
  })
}
