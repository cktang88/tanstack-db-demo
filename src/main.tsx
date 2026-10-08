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
  // a 401 anywhere means the session expired or was revoked: go to the login page
  queryCache: new QueryCache({ onError: (e) => isUnauthorized(e) && void router.navigate({ to: '/login' }) }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (isUnauthorized(error)) void router.navigate({ to: '/login' })
      else console.warn('[mutation failed]', error.message)
    },
  }),
})

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
