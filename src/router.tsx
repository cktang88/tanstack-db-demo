import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Link,
  redirect,
  stripSearchParams,
  type SearchSchemaInput,
} from '@tanstack/react-router'
import type { Me, Permission } from '../shared/domain'
import { ErrorView } from './components/ErrorView'
import { Layout } from './components/Layout'
import { Empty } from './components/ui'
import {
  customersCollection,
  invoicesCollection,
  mrrSnapshotsCollection,
  preloadAll,
  productsCollection,
  projectsCollection,
  queryClient as dbQueryClient,
  subscriptionsCollection,
  tasksCollection,
  teamMembersCollection,
  teamsCollection,
  timeEntriesCollection,
  usersCollection,
} from './db/collections'
import { startLiveSync } from './db/live'
import { HttpError } from './lib/api'
import { meQuery } from './lib/auth'
import { auditSearch, customersSearch, invoicesSearch } from './lib/search'
import { ActivityPage } from './routes/activity'
import { AnalyticsPage } from './routes/analytics'
import { AuditPage } from './routes/audit'
import { BillingPage } from './routes/billing'
import { CustomerDetailPage } from './routes/customer-detail'
import { CustomersPage } from './routes/customers'
import { InvoicesPage } from './routes/invoices'
import { LoginPage } from './routes/login'
import { OverviewPage } from './routes/overview'
import { ProductsPage } from './routes/products'
import { ProjectBoardPage } from './routes/project-board'
import { ProjectsPage } from './routes/projects'
import { SettingsPage } from './routes/settings'
import { TeamPage } from './routes/team'

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
 * Everything else requires a session. Once signed in, loaders only make sure
 * the collections a page reads are synced; afterwards navigation is instant —
 * pages query the local DB, not the network.
 */
let liveStarted = false
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context: { queryClient }, location }) => {
    const me = await queryClient.query(meQuery()).catch(() => null)
    if (!me) throw redirect({ to: '/login', search: { redirect: location.href } })
    if (!liveStarted) {
      liveStarted = true
      startLiveSync()
    }
    return { me }
  },
  loader: () => void preloadAll(),
  component: Layout,
})

const requires =
  (permission: Permission) =>
  ({ context }: { context: { me: Me } }) => {
    if (!context.me.permissions.includes(permission))
      throw new HttpError(403, { error: 'Forbidden', message: `You need the "${permission}" permission to view this page` })
  }

const overviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  loader: () => Promise.all([customersCollection.preload(), invoicesCollection.preload(), tasksCollection.preload()]),
  component: OverviewPage,
})

const analyticsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/analytics',
  loader: () => Promise.all([customersCollection.preload(), invoicesCollection.preload()]),
  component: AnalyticsPage,
})

export const customersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/customers',
  beforeLoad: requires('customers:read'),
  validateSearch: customersSearch,
  search: { middlewares: [stripSearchParams({ page: 1, pageSize: 25, sort: '-createdAt' })] },
  loader: () => Promise.all([customersCollection.preload(), usersCollection.preload()]),
  component: CustomersPage,
})

export const customerDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/customers/$customerId',
  beforeLoad: requires('customers:read'),
  params: {
    parse: (p) => ({ customerId: Number(p.customerId) }),
    stringify: (p) => ({ customerId: String(p.customerId) }),
  },
  loader: () =>
    Promise.all([
      customersCollection.preload(),
      invoicesCollection.preload(),
      usersCollection.preload(),
      subscriptionsCollection.preload(),
      productsCollection.preload(),
    ]),
  errorComponent: ErrorView,
  component: CustomerDetailPage,
})

export const invoicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/invoices',
  beforeLoad: requires('billing:read'),
  validateSearch: invoicesSearch,
  search: { middlewares: [stripSearchParams({ page: 1, pageSize: 25, sort: '-issuedAt' })] },
  loader: () => Promise.all([invoicesCollection.preload(), customersCollection.preload()]),
  component: InvoicesPage,
})

const billingRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/billing',
  beforeLoad: requires('billing:read'),
  loader: () => Promise.all([mrrSnapshotsCollection.preload(), invoicesCollection.preload(), customersCollection.preload()]),
  component: BillingPage,
})

const productsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/products',
  beforeLoad: requires('products:read'),
  loader: () => Promise.all([productsCollection.preload(), subscriptionsCollection.preload()]),
  component: ProductsPage,
})

export const auditRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/audit',
  beforeLoad: requires('audit:read'),
  validateSearch: auditSearch,
  loader: () => usersCollection.preload(),
  component: AuditPage,
})

const projectsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects',
  beforeLoad: requires('projects:read'),
  loader: () =>
    Promise.all([
      projectsCollection.preload(),
      tasksCollection.preload(),
      usersCollection.preload(),
      timeEntriesCollection.preload(),
    ]),
  component: ProjectsPage,
})

export const projectBoardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/projects/$projectId',
  beforeLoad: requires('projects:read'),
  params: {
    parse: (p) => ({ projectId: Number(p.projectId) }),
    stringify: (p) => ({ projectId: String(p.projectId) }),
  },
  loader: () => Promise.all([projectsCollection.preload(), tasksCollection.preload(), usersCollection.preload()]),
  errorComponent: ErrorView,
  component: ProjectBoardPage,
})

const teamRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/team',
  beforeLoad: requires('team:read'),
  loader: () =>
    Promise.all([
      usersCollection.preload(),
      tasksCollection.preload(),
      teamsCollection.preload(),
      teamMembersCollection.preload(),
    ]),
  component: TeamPage,
})

const activityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/activity',
  loader: () => usersCollection.preload(),
  component: ActivityPage,
})

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  component: SettingsPage,
})

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    overviewRoute,
    analyticsRoute,
    customersRoute,
    customerDetailRoute,
    invoicesRoute,
    billingRoute,
    productsRoute,
    auditRoute,
    projectsRoute,
    projectBoardRoute,
    teamRoute,
    activityRoute,
    settingsRoute,
  ]),
])

export function makeRouter() {
  return createRouter({
    routeTree,
    context: { queryClient: dbQueryClient },
    defaultPreload: 'intent',
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
