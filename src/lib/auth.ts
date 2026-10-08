import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import type { Me, Permission, Role } from '../../shared/domain'
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

/** Only follow same-origin, in-app redirect targets (never `//evil.com` or back to /login). */
export const safeRedirect = (target: unknown): string =>
  typeof target === 'string' && target.startsWith('/') && !target.startsWith('//') && !target.startsWith('/login') ? target : '/'

/** Current session (suspends; only used inside the authenticated layout). */
export function useMe() {
  return useSuspenseQuery(meQuery()).data
}

export function useCan() {
  const me = useMe()
  const privileged = me.user.role === 'owner' || me.user.role === 'admin'
  return {
    me,
    can: (p: Permission) => me.permissions.includes(p),
    /** row-level rule mirrored from the server: members may only edit customers they own */
    canEditCustomer: (c: { ownerId: number | null }) =>
      me.permissions.includes('customers:write') && (privileged || c.ownerId === me.user.id),
    canEditProject: (p: { teamId: number | null; ownerId: number | null }) =>
      me.permissions.includes('projects:write') &&
      (privileged || p.ownerId === me.user.id || (p.teamId !== null && me.teamIds.includes(p.teamId))),
  }
}

export function useLogin({ redirect }: { redirect?: string } = {}) {
  const qc = useQueryClient()
  const router = useRouter()
  return useMutation({
    mutationKey: ['auth', 'login'],
    mutationFn: (creds: { email: string; password: string }) => api.post<Me & { token: string }>('/auth/login', creds),
    onSuccess: async ({ token: _token, ...me }) => {
      qc.clear() // never leak cached data between users
      qc.setQueryData(meQuery().queryKey, me)
      await router.navigate({ href: safeRedirect(redirect), replace: true })
    },
  })
}

export function useLogout() {
  const qc = useQueryClient()
  const router = useRouter()
  return useMutation({
    mutationFn: () => api.post('/auth/logout', {}),
    onSettled: async () => {
      qc.clear()
      await router.navigate({ to: '/login' })
    },
  })
}
