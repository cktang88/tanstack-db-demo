import { QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { queryClient } from './db/collections'
import { startLiveSync } from './db/live'
import { makeRouter } from './router'
import './styles.css'

const router = makeRouter()
startLiveSync()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* TanStack Query is still here: it's the fetch/cache engine under every query collection. */}
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <ReactQueryDevtools buttonPosition="bottom-left" />
    </QueryClientProvider>
  </StrictMode>,
)
