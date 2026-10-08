import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { queryClient } from './db/collections'
import { isUnauthorized } from './lib/auth'
import { makeRouter } from './router'
import './styles.css'

const router = makeRouter()
// a 401 anywhere means the session expired or was revoked: go to the login page
const on401 = (e: unknown) => isUnauthorized(e) && void router.navigate({ to: '/login' })
queryClient.getQueryCache().subscribe((ev) => ev.type === 'updated' && ev.action.type === 'error' && on401(ev.action.error))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* TanStack Query is still here: it's the fetch/cache engine under every query collection. */}
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <ReactQueryDevtools buttonPosition="bottom-left" />
    </QueryClientProvider>
  </StrictMode>,
)
