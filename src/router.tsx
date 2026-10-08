import { createRootRoute, createRoute, createRouter, Link, stripSearchParams } from '@tanstack/react-router'
import { ErrorView } from './components/ErrorView'
import { Layout } from './components/Layout'
import { Empty } from './components/ui'
import {
  customersCollection,
  invoicesCollection,
  preloadAll,
  projectsCollection,
  tasksCollection,
  usersCollection,
} from './db/collections'
import { customersSearch, invoicesSearch } from './lib/search'
import { ActivityPage } from './routes/activity'
import { AnalyticsPage } from './routes/analytics'
import { CustomerDetailPage } from './routes/customer-detail'
import { CustomersPage } from './routes/customers'
import { InvoicesPage } from './routes/invoices'
import { OverviewPage } from './routes/overview'
import { ProjectBoardPage } from './routes/project-board'
import { ProjectsPage } from './routes/projects'
import { SettingsPage } from './routes/settings'
import { TeamPage } from './routes/team'

// Loaders just make sure the collections a page reads are synced. Once loaded,
// every navigation is instant: pages query the local DB, not the network.
const rootRoute = createRootRoute({
  component: Layout,
  loader: () => void preloadAll(),
  notFoundComponent: () => (
    <Empty>
      Page not found. <Link to="/">Go home</Link>
    </Empty>
  ),
})

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  loader: () => Promise.all([customersCollection.preload(), invoicesCollection.preload(), tasksCollection.preload()]),
  component: OverviewPage,
})

const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/analytics',
  loader: () => Promise.all([customersCollection.preload(), invoicesCollection.preload()]),
  component: AnalyticsPage,
})

export const customersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/customers',
  validateSearch: customersSearch,
  search: { middlewares: [stripSearchParams({ page: 1, pageSize: 25, sort: '-createdAt' })] },
  loader: () => Promise.all([customersCollection.preload(), usersCollection.preload()]),
  component: CustomersPage,
})

export const customerDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/customers/$customerId',
  params: {
    parse: (p) => ({ customerId: Number(p.customerId) }),
    stringify: (p) => ({ customerId: String(p.customerId) }),
  },
  loader: () => Promise.all([customersCollection.preload(), invoicesCollection.preload(), usersCollection.preload()]),
  errorComponent: ErrorView,
  component: CustomerDetailPage,
})

export const invoicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invoices',
  validateSearch: invoicesSearch,
  search: { middlewares: [stripSearchParams({ page: 1, pageSize: 25, sort: '-issuedAt' })] },
  loader: () => Promise.all([invoicesCollection.preload(), customersCollection.preload()]),
  component: InvoicesPage,
})

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  loader: () => Promise.all([projectsCollection.preload(), tasksCollection.preload(), usersCollection.preload()]),
  component: ProjectsPage,
})

export const projectBoardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  params: {
    parse: (p) => ({ projectId: Number(p.projectId) }),
    stringify: (p) => ({ projectId: String(p.projectId) }),
  },
  loader: () => Promise.all([projectsCollection.preload(), tasksCollection.preload(), usersCollection.preload()]),
  errorComponent: ErrorView,
  component: ProjectBoardPage,
})

const teamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/team',
  loader: () => Promise.all([usersCollection.preload(), tasksCollection.preload()]),
  component: TeamPage,
})

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activity',
  loader: () => usersCollection.preload(),
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

export function makeRouter() {
  return createRouter({
    routeTree,
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
