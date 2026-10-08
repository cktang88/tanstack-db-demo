import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { isUnauthorized } from './lib/auth'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HttpError } from './lib/api'
import { startLiveUpdates } from './lib/live'
import { makeRouter } from './router'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // don't retry 4xx — they won't fix themselves
      retry: (count, error) => !(error instanceof HttpError && error.status < 500) && count < 2,
      throwOnError: (error) => error instanceof HttpError && error.status === 403,
    },
  },
  queryCache: new QueryCache({ onError: (e) => isUnauthorized(e) && signedOut() }),
  mutationCache: new MutationCache({
    onError: (error, _v, _c, mutation) => {
      // a wrong password is a 401 too, but that's the login form's business
      if (isUnauthorized(error) && mutation.options.mutationKey?.[1] !== 'login') signedOut()
      else console.warn('[mutation failed]', error.message)
    },
  }),
})

/**
 * A 401 anywhere means the session expired or was revoked. Drop every cached
 * entry (so Back can't show the previous user's pages) and go to the login
 * page, remembering where we were.
 */
function signedOut() {
  const { pathname, href } = router.latestLocation
  if (pathname === '/login') return
  queryClient.clear()
  void router.navigate({ to: '/login', search: { redirect: href }, replace: true })
}

const router = makeRouter(queryClient)
startLiveUpdates(queryClient)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <ReactQueryDevtools buttonPosition="bottom-left" />
    </QueryClientProvider>
  </StrictMode>,
)
