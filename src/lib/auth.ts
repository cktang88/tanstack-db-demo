import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import type { Me, Permission, Role } from '../../shared/domain'
import { resetServerCollections } from '../db/collections'
import { startLiveSync, stopLiveSync } from '../db/live'
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

export function useLogin() {
  const qc = useQueryClient()
  const router = useRouter()
  return useMutation({
    mutationFn: (creds: { email: string; password: string }) => api.post<Me & { token: string }>('/auth/login', creds),
    onSuccess: async ({ token: _token, ...me }) => {
      // never leak another user's rows: drop every collection, then sync fresh as the new user
      await resetServerCollections()
      qc.setQueryData(meQuery().queryKey, me)
      startLiveSync()
      await router.navigate({ to: '/' })
    },
  })
}

export function useLogout() {
  const qc = useQueryClient()
  const router = useRouter()
  return useMutation({
    mutationFn: () => api.post('/auth/logout', {}),
    onSettled: async () => {
      stopLiveSync()
      await resetServerCollections()
      qc.removeQueries({ queryKey: ['auth', 'me'] })
      await router.navigate({ to: '/login' })
    },
  })
}
