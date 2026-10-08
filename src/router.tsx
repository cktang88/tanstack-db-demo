import { noop, QueryClient } from '@tanstack/react-query'
import { redirect } from '@tanstack/react-router'
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
import { HttpError } from './lib/api'
import { isUnauthorized, meQuery } from './lib/auth'
import { arAgingQuery, mrrSnapshotsQuery, productsQuery, projectStatsQuery } from './lib/queries'
import { auditSearch, customersSearch, invoicesSearch } from './lib/search'
import type { Me, Permission } from '../shared/domain'
import type { SearchSchemaInput } from '@tanstack/react-router'
import { LoginPage } from './routes/login'
import { BillingPage } from './routes/billing'
import { ProductsPage } from './routes/products'
import { AuditPage } from './routes/audit'
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
  notFoundComponent: () => (
    <Empty>
      Page not found. <Link to="/">Go home</Link>
    </Empty>
  ),
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (s: { redirect?: unknown } & SearchSchemaInput) => ({
    redirect: typeof s.redirect === 'string' ? s.redirect : undefined,
  }),
  component: LoginPage,
})

/**
 * Loader-only options: resolve from cache whenever *any* data is cached (even stale).
 * See the note above the page routes.
 */
const cached = <O extends object>(options: O) => ({ ...options, staleTime: 'static' as const })

/** Everything else requires a session: the guard resolves /auth/me before any child loader runs. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context: { queryClient }, location }) => {
    try {
      // a cached session never blocks navigation (see `cached`); the layout's useSuspenseQuery revalidates it
      return { me: await queryClient.query(cached(meQuery())) }
    } catch (e) {
      // only a 401 means "signed out"; anything else (5xx, network) is a real error
      if (isUnauthorized(e)) throw redirect({ to: '/login', search: { redirect: location.href } })
      throw e
    }
  },
  component: Layout,
})

/** Route-level permission check (the server enforces it too; this just avoids showing a dead page). */
const requires =
  (permission: Permission) =>
  ({ context }: { context: { me: Me } }) => {
    if (!context.me.permissions.includes(permission))
      throw new HttpError(403, { error: 'Forbidden', message: `You need the "${permission}" permission to view this page` })
  }

// Loaders use `queryClient.query()` (5.102+, replaces the deprecated ensureQueryData/fetchQuery)
// so data starts loading in parallel with the route's JS, not in a useEffect waterfall.
// `query()` fetches whenever the entry is stale, which would block navigation on a
// refetch of data we already have; `cached()` sets staleTime 'static' for the loader
// call only, so any cached data resolves immediately and only a cold cache waits.
// The page's useSuspenseQuery/useQuery then revalidates stale data on mount.
// (Lists with keepPreviousData are prefetched without blocking at all.)
const overviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  loader: ({ context: { queryClient } }) =>
    Promise.all([queryClient.query(cached(overviewQuery())), queryClient.query(cached(revenueQuery(12)))]),
  component: OverviewPage,
})

const analyticsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/analytics',
  component: AnalyticsPage,
})

export const customersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/customers',
  validateSearch: customersSearch,
  // keep URLs short: don't serialise default values
  search: { middlewares: [stripSearchParams({ page: 1, pageSize: 25, sort: '-createdAt' })] },
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => {
    // don't block navigation on refetches of pages we already have
    void queryClient.query(customersListQuery(deps)).catch(noop)
    return queryClient.query(cached(usersQuery()))
  },
  component: CustomersPage,
})

export const customerDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/customers/$customerId',
  params: {
    parse: (p) => ({ customerId: Number(p.customerId) }),
    stringify: (p) => ({ customerId: String(p.customerId) }),
  },
  loader: ({ context: { queryClient }, params }) => {
    void queryClient.query(customerInvoicesQuery(params.customerId)).catch(noop)
    void queryClient.query(customerActivityQuery(params.customerId)).catch(noop)
    return queryClient.query(cached(customerQuery(params.customerId)))
  },
  errorComponent: ErrorView,
  component: CustomerDetailPage,
})

export const invoicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/invoices',
  validateSearch: invoicesSearch,
  search: { middlewares: [stripSearchParams({ page: 1, pageSize: 25, sort: '-issuedAt' })] },
  loaderDeps: ({ search }) => search,
  loader: ({ context: { queryClient }, deps }) => void queryClient.query(invoicesListQuery(deps)).catch(noop),
  component: InvoicesPage,
})

const projectsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects',
  loader: ({ context: { queryClient } }) =>
    Promise.all([queryClient.query(cached(projectsQuery())), queryClient.query(cached(projectStatsQuery()))]),
  component: ProjectsPage,
})

export const projectBoardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId',
  params: {
    parse: (p) => ({ projectId: Number(p.projectId) }),
    stringify: (p) => ({ projectId: String(p.projectId) }),
  },
  loader: ({ context: { queryClient }, params }) =>
    Promise.all([
      queryClient.query(cached(projectQuery(params.projectId))),
      queryClient.query(cached(projectTasksQuery(params.projectId))),
      queryClient.query(cached(usersQuery())),
    ]),
  errorComponent: ErrorView,
  component: ProjectBoardPage,
})

const teamRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/team',
  loader: ({ context: { queryClient } }) => queryClient.query(cached(usersQuery())),
  component: TeamPage,
})

const activityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/activity',
  loader: ({ context: { queryClient } }) => queryClient.infiniteQuery(cached(activityFeedQuery())),
  component: ActivityPage,
})

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  component: SettingsPage,
})

const billingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/billing',
  beforeLoad: requires('billing:read'),
  loader: ({ context: { queryClient } }) =>
    Promise.all([queryClient.query(cached(mrrSnapshotsQuery())), queryClient.query(cached(arAgingQuery()))]),
  component: BillingPage,
})

const productsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products',
  beforeLoad: requires('products:read'),
  loader: ({ context: { queryClient } }) => queryClient.query(cached(productsQuery())),
  component: ProductsPage,
})

export const auditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/audit',
  beforeLoad: requires('audit:read'),
  validateSearch: auditSearch,
  component: AuditPage,
})

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    overviewRoute,
    billingRoute,
    productsRoute,
    auditRoute,
    analyticsRoute,
    customersRoute,
    customerDetailRoute,
    invoicesRoute,
    projectsRoute,
    projectBoardRoute,
    teamRoute,
    activityRoute,
    settingsRoute,
  ]),
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
