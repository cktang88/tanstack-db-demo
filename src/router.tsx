import { noop, QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, createRoute, createRouter, Link, stripSearchParams } from '@tanstack/react-router'
import { Layout } from './components/Layout'
import { Empty } from './components/ui'
import {
  activityFeedQuery,
  customerActivityQuery,
  customerInvoicesQuery,
  customerQuery,
  customersListQuery,
  invoicesListQuery,
  overviewQuery,
  projectQuery,
  projectsQuery,
  projectTasksQuery,
  revenueQuery,
  usersQuery,
} from './lib/queries'
import { customersSearch, invoicesSearch } from './lib/search'
import { OverviewPage } from './routes/overview'
import { AnalyticsPage } from './routes/analytics'
import { CustomersPage } from './routes/customers'
import { CustomerDetailPage } from './routes/customer-detail'
import { InvoicesPage } from './routes/invoices'
import { ProjectsPage } from './routes/projects'
import { ProjectBoardPage } from './routes/project-board'
import { TeamPage } from './routes/team'
import { ActivityPage } from './routes/activity'
import { SettingsPage } from './routes/settings'
import { ErrorView } from './components/ErrorView'

export interface RouterContext {
  queryClient: QueryClient
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Layout,
  notFoundComponent: () => (
    <Empty>
      Page not found. <Link to="/">Go home</Link>
    </Empty>
  ),
})

// Loaders use `ensureQueryData` so navigations render instantly from cache and
// data starts loading in parallel with the route's JS, not in a useEffect waterfall.
const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  loader: ({ context: { queryClient } }) =>
    Promise.all([queryClient.query(overviewQuery()), queryClient.query(revenueQuery(12))]),
  component: OverviewPage,
})

const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/analytics',
  component: AnalyticsPage,
})

export const customersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/customers',
  validateSearch: customersSearch,
  // keep URLs short: don't serialise default values
  search: { middlewares: [stripSearchParams({ page: 1, pageSize: 25, sort: '-createdAt' })] },
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => {
    // don't block navigation on refetches of pages we already have
    void queryClient.query(customersListQuery(deps)).catch(noop)
    return queryClient.query(usersQuery())
  },
  component: CustomersPage,
})

export const customerDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/customers/$customerId',
  params: {
    parse: (p) => ({ customerId: Number(p.customerId) }),
    stringify: (p) => ({ customerId: String(p.customerId) }),
  },
  loader: ({ context: { queryClient }, params }) => {
    void queryClient.query(customerInvoicesQuery(params.customerId)).catch(noop)
    void queryClient.query(customerActivityQuery(params.customerId)).catch(noop)
    return queryClient.query(customerQuery(params.customerId))
  },
  errorComponent: ErrorView,
  component: CustomerDetailPage,
})

export const invoicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invoices',
  validateSearch: invoicesSearch,
  search: { middlewares: [stripSearchParams({ page: 1, pageSize: 25, sort: '-issuedAt' })] },
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => void queryClient.query(invoicesListQuery(deps)).catch(noop),
  component: InvoicesPage,
})

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  loader: ({ context: { queryClient } }) => queryClient.query(projectsQuery()),
  component: ProjectsPage,
})

export const projectBoardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  params: {
    parse: (p) => ({ projectId: Number(p.projectId) }),
    stringify: (p) => ({ projectId: String(p.projectId) }),
  },
  loader: ({ context: { queryClient }, params }) =>
    Promise.all([
      queryClient.query(projectQuery(params.projectId)),
      queryClient.query(projectTasksQuery(params.projectId)),
      queryClient.query(usersQuery()),
    ]),
  errorComponent: ErrorView,
  component: ProjectBoardPage,
})

const teamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/team',
  loader: ({ context: { queryClient } }) => queryClient.query(usersQuery()),
  component: TeamPage,
})

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activity',
  loader: ({ context: { queryClient } }) => queryClient.infiniteQuery(activityFeedQuery()),
  component: ActivityPage,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

const routeTree = rootRoute.addChildren([
  overviewRoute,
  analyticsRoute,
  customersRoute,
  customerDetailRoute,
  invoicesRoute,
  projectsRoute,
  projectBoardRoute,
  teamRoute,
  activityRoute,
  settingsRoute,
])

export function makeRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    // let TanStack Query own caching; the router always calls loaders
    defaultPreloadStaleTime: 0,
    defaultPendingMs: 150,
    defaultErrorComponent: ErrorView,
    scrollRestoration: true,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>
  }
}
