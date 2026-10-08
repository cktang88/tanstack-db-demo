import { Schema } from 'effect'
import type { Permission } from '../shared/domain.ts'
import * as S from '../shared/schemas.ts'
import type { DB } from './db/schema.ts'
import type { Columns } from './db/sql.ts'
import type { Principal } from './services.ts'

/**
 * Declarative resource registry. Every table is exposed through the same
 * generic REST surface (list with filter/sort/search/paging, get, create,
 * update, delete) and the same batch endpoint, but each resource declares:
 *
 *  - which permission reads / writes it
 *  - its mode: crud | append-only | read-only (rollups, views, logs)
 *  - row-level read scope (e.g. you only see *your* notifications)
 *  - row-level write rules (e.g. members may only edit customers they own)
 *  - which API fields are writable and how they map to columns
 */
export type Mode = 'crud' | 'append-only' | 'read-only'
/** a permission, or 'signed-in' for actions any authenticated user may take (row scope still applies) */
export type Access = Permission | 'signed-in'

export interface ScopeSql {
  sql: string
  params: unknown[]
}

export interface Resource {
  name: string
  table: string
  /** SQL expression for the row key (exposed as `id`) */
  key: string
  keyType: 'number' | 'text'
  columns: Columns
  search?: string[]
  defaultSort?: string
  /** null = any signed-in user */
  read: Permission | null
  create?: Access
  update?: Access
  remove?: Access
  mode: Mode
  /** API field -> SQL column for inserts/updates */
  writable?: Record<string, string>
  createSchema?: Schema.Top
  patchSchema?: Schema.Top
  /** rows belong to a user (column of that user id): reads are limited to the caller's rows */
  ownerField?: string
  /** extra WHERE applied to every read (row-level security / soft delete) */
  scope?: (me: Principal) => ScopeSql | undefined
  /**
   * Row-level write check against the current row (update/delete) or the new row (create).
   * Updates are checked twice: against the stored row, then against the merged
   * row (stored + patch) with `before` set to the stored row.
   */
  canWrite?: (
    me: Principal,
    row: Record<string, any>,
    db: DB,
    op: 'create' | 'update' | 'delete',
    before?: Record<string, any>,
  ) => string | undefined
  /** values used when the client omits them */
  defaults?: (me: Principal) => Record<string, unknown>
  /** fields the server always sets on create, overriding the client (e.g. author = caller) */
  forced?: (me: Principal) => Record<string, unknown>
  /** soft delete column instead of DELETE */
  softDelete?: string
  /** entity name used for audit + change feed (defaults to name) */
  entity?: string
}

const n = (sql: string) => ({ sql, type: 'number' as const })
const t = (sql: string) => ({ sql, type: 'text' as const })
const b = (sql: string) => ({ sql, type: 'bool' as const })

/** rows of archived (soft-deleted) customers are history: kept, but not served */
const liveCustomer = (): ScopeSql => ({ sql: 'customer_id IN (SELECT id FROM customers WHERE deleted_at IS NULL)', params: [] })

const own =
  (column: string) =>
  (me: Principal): ScopeSql => ({ sql: `${column} = ?`, params: [me.user.id] })

// ---------------- row-level write rules ----------------
const ownsCustomer = (me: Principal, customerOwnerId: unknown) =>
  me.privileged || customerOwnerId === me.user.id ? undefined : 'Members can only modify customers they own'

const customerOwner = (db: DB, customerId: unknown) =>
  (db.prepare(`SELECT owner_id AS o FROM customers WHERE id = ?`).get(customerId) as { o: number | null } | undefined)?.o

const projectTeam = (db: DB, projectId: unknown) =>
  db.prepare(`SELECT team_id AS teamId, owner_id AS ownerId FROM projects WHERE id = ?`).get(projectId) as
    | { teamId: number | null; ownerId: number | null }
    | undefined

/** members may work on projects they own or that belong to one of their teams */
const projectAccess = (me: Principal, p: { teamId: number | null; ownerId: number | null }) =>
  me.privileged || p.ownerId === me.user.id || (p.teamId !== null && me.teamIds.includes(p.teamId))
    ? undefined
    : 'Members can only modify projects owned by one of their teams'

const canTouchProject = (me: Principal, db: DB, projectId: unknown) => {
  if (me.privileged) return undefined
  const p = projectTeam(db, projectId)
  if (!p) return undefined // 404 / FK violation is reported elsewhere
  return projectAccess(me, p)
}

const canWriteProject: Resource['canWrite'] = (me, row, _db, op, before) => {
  if (me.privileged) return undefined
  const teamId = (row.teamId ?? null) as number | null
  const ownerId = (row.ownerId ?? null) as number | null
  if (op === 'create') {
    if (teamId === null || !me.teamIds.includes(teamId)) return 'Create projects for your own team'
    if (ownerId !== null && ownerId !== me.user.id) return 'Members can only make themselves the project owner'
    return undefined
  }
  if (before) {
    // the patched row: no moving projects to other teams, no handing them to someone else
    if (teamId !== (before.teamId ?? null) && (teamId === null || !me.teamIds.includes(teamId)))
      return 'Members can only move projects to one of their teams'
    if (ownerId !== (before.ownerId ?? null) && ownerId !== me.user.id)
      return 'Members can only make themselves the project owner'
  }
  return projectAccess(me, { teamId, ownerId })
}

/** what a task's assignee may change on a task outside their teams' projects */
const ASSIGNEE_FIELDS = new Set(['status', 'position', 'updatedAt'])

const canWriteTask: Resource['canWrite'] = (me, row, db, op, before) => {
  if (op !== 'update') return canTouchProject(me, db, row.projectId)
  if (!before) return row.assigneeId === me.user.id ? undefined : canTouchProject(me, db, row.projectId)
  // the patched row: moving a task needs access to both projects
  if (row.projectId !== before.projectId)
    return canTouchProject(me, db, before.projectId) ?? canTouchProject(me, db, row.projectId)
  const changed = Object.keys(row).filter((k) => JSON.stringify(row[k]) !== JSON.stringify(before[k]))
  if (before.assigneeId === me.user.id && changed.every((k) => ASSIGNEE_FIELDS.has(k))) return undefined
  return canTouchProject(me, db, row.projectId)
}

export const resources: Record<string, Resource> = {
  // ============================== identity & access ==============================
  roles: {
    name: 'roles',
    table: 'roles',
    key: 'id',
    keyType: 'text',
    columns: { id: t('id'), name: t('name'), description: t('description'), rank: n('rank') },
    defaultSort: 'rank',
    read: 'team:read',
    mode: 'read-only',
  },
  permissions: {
    name: 'permissions',
    table: 'permissions',
    key: 'id',
    keyType: 'text',
    columns: { id: t('id'), description: t('description') },
    defaultSort: 'id',
    read: 'team:read',
    mode: 'read-only',
  },
  'role-permissions': {
    name: 'role-permissions',
    table: 'role_permissions',
    key: `role_id || ':' || permission_id`,
    keyType: 'text',
    columns: { id: t(`role_id || ':' || permission_id`), roleId: t('role_id'), permissionId: t('permission_id') },
    defaultSort: 'roleId',
    read: 'team:read',
    mode: 'read-only',
  },
  users: {
    name: 'users',
    table: 'users',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      name: t('name'),
      email: t('email'),
      role: t('role'),
      title: t('title'),
      avatarColor: t('avatar_color'),
      active: b('active'),
      createdAt: t('created_at'),
    },
    search: ['name', 'email', 'title'],
    defaultSort: 'name',
    read: null, // every signed-in user can see teammates' names
    update: 'team:manage',
    mode: 'crud',
    writable: { name: 'name', role: 'role', title: 'title', active: 'active' },
    patchSchema: S.UserPatch,
    canWrite: (me, row, _db, _op) => {
      if (row.role === 'owner' && me.user.role !== 'owner') return 'Only the owner can modify the owner account'
      if (row.id === me.user.id && row.role !== me.user.role) return 'You cannot change your own role'
      return undefined
    },
  },
  sessions: {
    name: 'sessions',
    table: 'sessions',
    key: 'rowid',
    keyType: 'number',
    columns: {
      id: n('rowid'),
      userId: n('user_id'),
      createdAt: t('created_at'),
      expiresAt: t('expires_at'),
      userAgent: t('user_agent'),
    },
    defaultSort: '-createdAt',
    read: null,
    remove: 'signed-in', // revoke your own sessions (scope below)
    mode: 'crud',
    ownerField: 'userId',
    scope: own('user_id'),
    canWrite: (me, row) => (row.userId === me.user.id ? undefined : 'You can only revoke your own sessions'),
  },
  teams: {
    name: 'teams',
    table: 'teams',
    key: 'id',
    keyType: 'number',
    columns: { id: n('id'), name: t('name'), description: t('description'), leadId: n('lead_id'), createdAt: t('created_at') },
    search: ['name'],
    defaultSort: 'name',
    read: 'team:read',
    create: 'team:manage',
    update: 'team:manage',
    remove: 'team:manage',
    mode: 'crud',
    writable: { id: 'id', name: 'name', description: 'description', leadId: 'lead_id', createdAt: 'created_at' },
    createSchema: S.TeamInput,
    patchSchema: S.TeamPatch,
    defaults: () => ({ createdAt: new Date().toISOString() }),
  },
  'team-members': {
    name: 'team-members',
    table: 'team_members',
    key: `team_id || ':' || user_id`,
    keyType: 'text',
    columns: { id: t(`team_id || ':' || user_id`), teamId: n('team_id'), userId: n('user_id'), joinedAt: t('joined_at') },
    defaultSort: 'teamId',
    read: 'team:read',
    create: 'team:manage',
    remove: 'team:manage',
    mode: 'crud',
    writable: { teamId: 'team_id', userId: 'user_id', joinedAt: 'joined_at' },
    createSchema: S.TeamMemberInput,
    defaults: () => ({ joinedAt: new Date().toISOString() }),
  },

  // ============================== CRM ==============================
  customers: {
    name: 'customers',
    table: 'customers',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      name: t('name'),
      email: t('email'),
      company: t('company'),
      plan: t('plan'),
      status: t('status'),
      country: t('country'),
      seats: n('seats'),
      mrr: n('mrr'),
      ownerId: n('owner_id'),
      teamId: n('team_id'),
      createdAt: t('created_at'),
      updatedAt: t('updated_at'),
    },
    search: ['name', 'email', 'company'],
    defaultSort: '-createdAt',
    read: 'customers:read',
    create: 'customers:write',
    update: 'customers:write',
    remove: 'customers:delete',
    mode: 'crud',
    softDelete: 'deleted_at',
    scope: () => ({ sql: 'deleted_at IS NULL', params: [] }),
    // create/update go through business logic (subscriptions) in handlers.ts
    canWrite: (me, row, _db, op) => (op === 'create' ? undefined : ownsCustomer(me, row.ownerId)),
  },
  contacts: {
    name: 'contacts',
    table: 'contacts',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      customerId: n('customer_id'),
      name: t('name'),
      email: t('email'),
      title: t('title'),
      isPrimary: b('is_primary'),
      createdAt: t('created_at'),
    },
    search: ['name', 'email', 'title'],
    defaultSort: 'name',
    read: 'customers:read',
    create: 'customers:write',
    update: 'customers:write',
    remove: 'customers:write',
    mode: 'crud',
    scope: liveCustomer,
    writable: {
      id: 'id',
      customerId: 'customer_id',
      name: 'name',
      email: 'email',
      title: 'title',
      isPrimary: 'is_primary',
      createdAt: 'created_at',
    },
    createSchema: S.ContactInput,
    patchSchema: S.ContactPatch,
    defaults: () => ({ createdAt: new Date().toISOString() }),
    canWrite: (me, row, db) => ownsCustomer(me, customerOwner(db, row.customerId)),
  },
  tags: {
    name: 'tags',
    table: 'tags',
    key: 'id',
    keyType: 'number',
    columns: { id: n('id'), name: t('name'), color: t('color') },
    defaultSort: 'name',
    read: 'customers:read',
    create: 'team:manage',
    update: 'team:manage',
    remove: 'team:manage',
    mode: 'crud',
    writable: { id: 'id', name: 'name', color: 'color' },
    createSchema: S.TagInput,
    patchSchema: S.TagPatch,
  },
  'customer-tags': {
    name: 'customer-tags',
    table: 'customer_tags',
    key: `customer_id || ':' || tag_id`,
    keyType: 'text',
    columns: {
      id: t(`customer_id || ':' || tag_id`),
      customerId: n('customer_id'),
      tagId: n('tag_id'),
      taggedAt: t('tagged_at'),
    },
    defaultSort: 'customerId',
    read: 'customers:read',
    create: 'customers:write',
    remove: 'customers:write',
    mode: 'crud',
    scope: liveCustomer,
    writable: { customerId: 'customer_id', tagId: 'tag_id', taggedAt: 'tagged_at' },
    createSchema: S.CustomerTagInput,
    defaults: () => ({ taggedAt: new Date().toISOString() }),
    canWrite: (me, row, db) => ownsCustomer(me, customerOwner(db, row.customerId)),
  },

  // ============================== catalog & billing ==============================
  products: {
    name: 'products',
    table: 'products',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      sku: t('sku'),
      name: t('name'),
      kind: t('kind'),
      planCode: t('plan_code'),
      unitPrice: n('unit_price'),
      active: b('active'),
      createdAt: t('created_at'),
    },
    search: ['sku', 'name'],
    defaultSort: 'id',
    read: 'products:read',
    create: 'products:write',
    update: 'products:write',
    mode: 'crud',
    writable: {
      id: 'id',
      sku: 'sku',
      name: 'name',
      kind: 'kind',
      planCode: 'plan_code',
      unitPrice: 'unit_price',
      active: 'active',
      createdAt: 'created_at',
    },
    createSchema: S.ProductInput,
    patchSchema: S.ProductPatch,
    defaults: () => ({ createdAt: new Date().toISOString() }),
  },
  subscriptions: {
    name: 'subscriptions',
    table: 'subscriptions',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      customerId: n('customer_id'),
      productId: n('product_id'),
      quantity: n('quantity'),
      unitPrice: n('unit_price'),
      status: t('status'),
      startedAt: t('started_at'),
      canceledAt: t('canceled_at'),
    },
    defaultSort: 'id',
    read: 'billing:read',
    create: 'billing:write',
    update: 'billing:write',
    mode: 'crud', // create/update via business logic in handlers.ts
    scope: liveCustomer,
  },
  invoices: {
    name: 'invoices',
    table: 'invoices',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      number: t('number'),
      customerId: n('customer_id'),
      amount: n('amount'),
      status: t('status'),
      issuedAt: t('issued_at'),
      dueAt: t('due_at'),
      paidAt: t('paid_at'),
    },
    search: ['number'],
    defaultSort: '-issuedAt',
    read: 'billing:read',
    update: 'billing:write',
    mode: 'crud', // status transitions via business logic in handlers.ts
    scope: liveCustomer,
  },
  'invoice-line-items': {
    name: 'invoice-line-items',
    table: 'invoice_line_items',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      invoiceId: n('invoice_id'),
      productId: n('product_id'),
      description: t('description'),
      quantity: n('quantity'),
      unitAmount: n('unit_amount'),
      amount: n('amount'),
    },
    defaultSort: 'id',
    read: 'billing:read',
    mode: 'read-only', // issued invoices are immutable
  },
  payments: {
    name: 'payments',
    table: 'payments',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      invoiceId: n('invoice_id'),
      customerId: n('customer_id'),
      amount: n('amount'),
      method: t('method'),
      reference: t('reference'),
      receivedAt: t('received_at'),
      recordedBy: n('recorded_by'),
    },
    search: ['reference'],
    defaultSort: '-receivedAt',
    read: 'billing:read',
    create: 'billing:write',
    mode: 'append-only', // ledger: corrections are new rows, never edits (create via handlers.ts)
    scope: liveCustomer,
  },
  'customer-balances': {
    name: 'customer-balances',
    table: 'customer_balances',
    key: 'customer_id',
    keyType: 'number',
    columns: {
      id: n('customer_id'),
      customerId: n('customer_id'),
      invoiced: n('invoiced'),
      paid: n('paid'),
      outstanding: n('outstanding'),
      overdue: n('overdue'),
      updatedAt: t('updated_at'),
    },
    defaultSort: '-outstanding',
    read: 'billing:read',
    mode: 'read-only', // rollup maintained by triggers
    scope: liveCustomer,
  },
  'mrr-movements': {
    name: 'mrr-movements',
    table: 'mrr_movements',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      customerId: n('customer_id'),
      at: t('at'),
      month: t('substr(at, 1, 7)'),
      kind: t('kind'),
      oldMrr: n('old_mrr'),
      newMrr: n('new_mrr'),
      delta: n('delta'),
    },
    defaultSort: '-id',
    read: 'billing:read',
    // ledger: written by a trigger on customers.mrr, never by clients. Like mrr-snapshots it is revenue
    // history and keeps archived customers' movements.
    mode: 'read-only',
  },
  'mrr-snapshots': {
    name: 'mrr-snapshots',
    table: 'mrr_snapshots',
    key: 'month',
    keyType: 'text',
    columns: {
      id: t('month'),
      month: t('month'),
      mrr: n('mrr'),
      activeCustomers: n('active_customers'),
      newCustomers: n('new_customers'),
      churnedCustomers: n('churned_customers'),
      newMrr: n('new_mrr'),
      churnedMrr: n('churned_mrr'),
      computedAt: t('computed_at'),
    },
    defaultSort: 'month',
    read: 'billing:read',
    mode: 'read-only', // rollup rebuilt by a job
  },

  // ============================== delivery ==============================
  projects: {
    name: 'projects',
    table: 'projects',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      name: t('name'),
      description: t('description'),
      customerId: n('customer_id'),
      ownerId: n('owner_id'),
      teamId: n('team_id'),
      status: t('status'),
      budgetHours: n('budget_hours'),
      createdAt: t('created_at'),
    },
    search: ['name'],
    defaultSort: 'name',
    read: 'projects:read',
    create: 'projects:write',
    update: 'projects:write',
    mode: 'crud',
    writable: {
      id: 'id',
      name: 'name',
      description: 'description',
      customerId: 'customer_id',
      ownerId: 'owner_id',
      teamId: 'team_id',
      status: 'status',
      budgetHours: 'budget_hours',
      createdAt: 'created_at',
    },
    createSchema: S.ProjectInput,
    patchSchema: S.ProjectPatch,
    defaults: () => ({ createdAt: new Date().toISOString() }),
    canWrite: canWriteProject,
  },
  'project-stats': {
    name: 'project-stats',
    table: 'project_stats',
    key: 'project_id',
    keyType: 'number',
    columns: {
      id: n('project_id'),
      projectId: n('project_id'),
      taskCount: n('task_count'),
      doneCount: n('done_count'),
      minutesLogged: n('minutes_logged'),
      billableMinutes: n('billable_minutes'),
    },
    defaultSort: 'projectId',
    read: 'projects:read',
    mode: 'read-only', // SQL view
  },
  tasks: {
    name: 'tasks',
    table: 'tasks',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      projectId: n('project_id'),
      title: t('title'),
      status: t('status'),
      priority: t('priority'),
      assigneeId: n('assignee_id'),
      dueDate: t('due_date'),
      position: n('position'),
      createdAt: t('created_at'),
      updatedAt: t('updated_at'),
    },
    search: ['title'],
    defaultSort: 'position',
    read: 'projects:read',
    create: 'projects:write',
    update: 'projects:write',
    remove: 'projects:write',
    mode: 'crud',
    writable: {
      id: 'id',
      projectId: 'project_id',
      title: 'title',
      status: 'status',
      priority: 'priority',
      assigneeId: 'assignee_id',
      dueDate: 'due_date',
      position: 'position',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    createSchema: S.TaskInput,
    patchSchema: S.TaskPatch,
    // new cards go to the bottom of their column
    defaults: () => ({ createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), position: Date.now() / 1000 }),
    canWrite: canWriteTask,
  },
  'task-comments': {
    name: 'task-comments',
    table: 'task_comments',
    key: 'id',
    keyType: 'number',
    columns: { id: n('id'), taskId: n('task_id'), authorId: n('author_id'), body: t('body'), createdAt: t('created_at') },
    defaultSort: 'createdAt',
    read: 'projects:read',
    create: 'comments:write',
    mode: 'append-only',
    writable: { id: 'id', taskId: 'task_id', authorId: 'author_id', body: 'body', createdAt: 'created_at' },
    createSchema: S.CommentInput,
    forced: (me) => ({ authorId: me.user.id, createdAt: new Date().toISOString() }),
  },
  'time-entries': {
    name: 'time-entries',
    table: 'time_entries',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      taskId: n('task_id'),
      userId: n('user_id'),
      minutes: n('minutes'),
      spentOn: t('spent_on'),
      billable: b('billable'),
      note: t('note'),
      createdAt: t('created_at'),
    },
    defaultSort: '-spentOn',
    read: 'projects:read',
    create: 'time:write',
    update: 'time:write',
    remove: 'time:write',
    mode: 'crud',
    writable: {
      id: 'id',
      taskId: 'task_id',
      userId: 'user_id',
      minutes: 'minutes',
      spentOn: 'spent_on',
      billable: 'billable',
      note: 'note',
      createdAt: 'created_at',
    },
    createSchema: S.TimeEntryInput,
    patchSchema: S.TimeEntryPatch,
    forced: (me) => ({ userId: me.user.id, createdAt: new Date().toISOString() }),
    canWrite: (me, row) => (me.privileged || row.userId === me.user.id ? undefined : 'You can only edit your own time entries'),
  },

  // ============================== metering ==============================
  'usage-events': {
    name: 'usage-events',
    table: 'usage_events',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      customerId: n('customer_id'),
      metric: t('metric'),
      quantity: n('quantity'),
      occurredAt: t('occurred_at'),
    },
    defaultSort: '-occurredAt',
    read: 'usage:read',
    create: 'usage:write',
    mode: 'append-only',
    scope: liveCustomer,
    writable: {
      id: 'id',
      customerId: 'customer_id',
      metric: 'metric',
      quantity: 'quantity',
      occurredAt: 'occurred_at',
      idempotencyKey: 'idempotency_key',
    },
    createSchema: S.UsageEventInput,
  },
  'usage-daily': {
    name: 'usage-daily',
    table: 'usage_daily',
    key: `customer_id || ':' || metric || ':' || day`,
    keyType: 'text',
    columns: {
      id: t(`customer_id || ':' || metric || ':' || day`),
      customerId: n('customer_id'),
      metric: t('metric'),
      day: t('day'),
      quantity: n('quantity'),
      events: n('events'),
    },
    defaultSort: 'day',
    read: 'usage:read',
    mode: 'read-only', // rollup maintained by trigger
    scope: liveCustomer,
  },
  'customer-health': {
    name: 'customer-health',
    table: 'customer_health',
    key: 'customer_id',
    keyType: 'number',
    columns: {
      id: n('customer_id'),
      customerId: n('customer_id'),
      mrr: n('mrr'),
      overdue: n('overdue'),
      apiCalls30d: n('api_calls_30d'),
      health: t('health'),
    },
    defaultSort: 'customerId',
    read: 'customers:read',
    mode: 'read-only', // SQL view joining customers, balances and usage rollups
  },

  // ============================== logs ==============================
  events: {
    name: 'events',
    table: 'events',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      type: t('type'),
      category: t(`substr(type, 1, instr(type, '.') - 1)`),
      actorId: n('actor_id'),
      customerId: n('customer_id'),
      message: t('message'),
      createdAt: t('created_at'),
    },
    defaultSort: '-id',
    read: null,
    mode: 'read-only', // written by the server as a side effect of other writes
  },
  'audit-log': {
    name: 'audit-log',
    table: 'audit_log',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      at: t('at'),
      actorId: n('actor_id'),
      action: t('action'),
      entity: t('entity'),
      entityId: n('entity_id'),
      entityKey: t('entity_key'),
      changes: t('changes'),
      requestId: t('request_id'),
    },
    search: ['entity', 'changes'],
    defaultSort: '-id',
    read: 'audit:read',
    mode: 'read-only', // append-only at the DB level; only the server writes it
  },
  notifications: {
    name: 'notifications',
    table: 'notifications',
    key: 'id',
    keyType: 'number',
    columns: {
      id: n('id'),
      userId: n('user_id'),
      kind: t('kind'),
      title: t('title'),
      body: t('body'),
      entity: t('entity'),
      entityId: n('entity_id'),
      createdAt: t('created_at'),
      readAt: t('read_at'),
    },
    defaultSort: '-createdAt',
    read: null,
    update: 'signed-in', // mark your own notifications read (scoped)
    mode: 'crud',
    ownerField: 'userId',
    scope: own('user_id'),
    writable: { readAt: 'read_at' },
    patchSchema: S.NotificationPatch,
    canWrite: (me, row) => (row.userId === me.user.id ? undefined : 'Not your notification'),
  },
}

export const RESOURCE_NAMES = Object.keys(resources)

/** Which permission is needed to *receive* change-feed messages for an entity. */
export const readPermissionOf = (entity: string) => (Object.hasOwn(resources, entity) ? resources[entity]!.read : undefined)
