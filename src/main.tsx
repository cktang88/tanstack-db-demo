import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { queryClient, setUnauthorizedHandler } from './db/collections'
import { clearSession, isUnauthorized } from './lib/auth'
import { makeRouter } from './router'
import './styles.css'

const router = makeRouter()
// A 401 anywhere (a read or a write) means the session expired or was revoked:
// stop the change feed, drop the previous session's data and cached identity
// (so the route guard can't let the user back in), then go to the login page.
let signingOut = false
const on401 = (e: unknown) => {
  if (!isUnauthorized(e) || signingOut) return
  const { pathname, href } = router.state.location
  if (pathname === '/login') return
  signingOut = true
  void clearSession(queryClient)
    .then(() => router.navigate({ to: '/login', search: { redirect: href } }))
    .finally(() => (signingOut = false))
}
queryClient.getQueryCache().subscribe((ev) => ev.type === 'updated' && ev.action.type === 'error' && on401(ev.action.error))
setUnauthorizedHandler(on401)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* TanStack Query is still here: it's the fetch/cache engine under every query collection. */}
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <ReactQueryDevtools buttonPosition="bottom-left" />
    </QueryClientProvider>
  </StrictMode>,
)
