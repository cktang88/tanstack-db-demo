import type {
  ActivityEvent,
  BreakdownPoint,
  Customer,
  CursorPage,
  Invoice,
  OverviewMetrics,
  Page,
  Project,
  RevenuePoint,
  SignupPoint,
  Task,
  User,
} from '../../shared/domain.ts'
import type { DB } from './schema.ts'
import { buildOrderBy, buildWhere, type Columns, type ListParams } from './sql.ts'

// ---------- column whitelists (API field name -> SQL) ----------

export const userColumns: Columns = {
  id: { sql: 'id', type: 'number' },
  name: { sql: 'name', type: 'text' },
  email: { sql: 'email', type: 'text' },
  role: { sql: 'role', type: 'text' },
  title: { sql: 'title', type: 'text' },
  active: { sql: 'active', type: 'bool' },
  createdAt: { sql: 'created_at', type: 'text' },
}

export const customerColumns: Columns = {
  id: { sql: 'id', type: 'number' },
  name: { sql: 'name', type: 'text' },
  email: { sql: 'email', type: 'text' },
  company: { sql: 'company', type: 'text' },
  plan: { sql: 'plan', type: 'text' },
  status: { sql: 'status', type: 'text' },
  country: { sql: 'country', type: 'text' },
  seats: { sql: 'seats', type: 'number' },
  mrr: { sql: 'mrr', type: 'number' },
  ownerId: { sql: 'owner_id', type: 'number' },
  createdAt: { sql: 'created_at', type: 'text' },
  updatedAt: { sql: 'updated_at', type: 'text' },
}

export const invoiceColumns: Columns = {
  id: { sql: 'id', type: 'number' },
  number: { sql: 'number', type: 'text' },
  customerId: { sql: 'customer_id', type: 'number' },
  amount: { sql: 'amount', type: 'number' },
  status: { sql: 'status', type: 'text' },
  issuedAt: { sql: 'issued_at', type: 'text' },
  dueAt: { sql: 'due_at', type: 'text' },
  paidAt: { sql: 'paid_at', type: 'text' },
}

export const projectColumns: Columns = {
  id: { sql: 'id', type: 'number' },
  name: { sql: 'name', type: 'text' },
  customerId: { sql: 'customer_id', type: 'number' },
  ownerId: { sql: 'owner_id', type: 'number' },
  status: { sql: 'status', type: 'text' },
  createdAt: { sql: 'created_at', type: 'text' },
}

export const taskColumns: Columns = {
  id: { sql: 'id', type: 'number' },
  projectId: { sql: 'project_id', type: 'number' },
  title: { sql: 'title', type: 'text' },
  status: { sql: 'status', type: 'text' },
  priority: { sql: 'priority', type: 'text' },
  assigneeId: { sql: 'assignee_id', type: 'number' },
  dueDate: { sql: 'due_date', type: 'text' },
  position: { sql: 'position', type: 'number' },
  createdAt: { sql: 'created_at', type: 'text' },
  updatedAt: { sql: 'updated_at', type: 'text' },
}

export const eventColumns: Columns = {
  id: { sql: 'id', type: 'number' },
  type: { sql: 'type', type: 'text' },
  actorId: { sql: 'actor_id', type: 'number' },
  customerId: { sql: 'customer_id', type: 'number' },
  createdAt: { sql: 'created_at', type: 'text' },
}

const select = (cols: Columns) =>
  Object.entries(cols)
    .map(([k, c]) => `${c.sql} AS "${k}"`)
    .join(', ')

const userSelect = `${select(userColumns)}, avatar_color AS "avatarColor"`
const projectSelect = `${select(projectColumns)}, description,
  (SELECT COUNT(*) FROM tasks t WHERE t.project_id = projects.id) AS "taskCount",
  (SELECT COUNT(*) FROM tasks t WHERE t.project_id = projects.id AND t.status = 'done') AS "doneCount"`

// ---------- row mappers ----------

const toUser = (r: any): User => ({ ...r, active: !!r.active })

// ---------- generic list ----------

function list<T>(
  db: DB,
  table: string,
  cols: Columns,
  selectSql: string,
  params: ListParams,
  searchFields: string[],
  map: (r: any) => T = (r) => r as T,
): { rows: T[]; total: number } {
  const where = buildWhere(cols, params.filters, { term: params.search, fields: searchFields })
  const order = buildOrderBy(cols, params.sorts)
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where.sql}`).get(...where.params) as { n: number }).n
  const limit = params.limit !== undefined ? `LIMIT ${Math.max(0, Math.floor(params.limit))}` : ''
  const offset = params.offset ? `OFFSET ${Math.max(0, Math.floor(params.offset))}` : ''
  const rows = db
    .prepare(`SELECT ${selectSql} FROM ${table} ${where.sql} ${order} ${limit || (offset ? 'LIMIT -1' : '')} ${offset}`)
    .all(...where.params)
    .map(map)
  return { rows, total }
}

export function toPage<T>(r: { rows: T[]; total: number }, params: ListParams): Page<T> {
  const pageSize = params.limit ?? r.total
  const page = pageSize ? Math.floor((params.offset ?? 0) / pageSize) + 1 : 1
  return { data: r.rows, total: r.total, page, pageSize, pageCount: pageSize ? Math.max(1, Math.ceil(r.total / pageSize)) : 1 }
}

const now = () => new Date().toISOString()

// ---------- users ----------

export const users = {
  list: (db: DB, p: ListParams) => list(db, 'users', userColumns, userSelect, p, ['name', 'email', 'title'], toUser),
  get: (db: DB, id: number): User | undefined => {
    const r = db.prepare(`SELECT ${userSelect} FROM users WHERE id = ?`).get(id)
    return r ? toUser(r) : undefined
  },
  update: (db: DB, id: number, patch: Partial<Pick<User, 'name' | 'role' | 'title' | 'active'>>): User | undefined => {
    const sets = setClause(patch, { name: 'name', role: 'role', title: 'title', active: 'active' })
    if (sets.sql) db.prepare(`UPDATE users SET ${sets.sql} WHERE id = ?`).run(...sets.params, id)
    return users.get(db, id)
  },
}

// ---------- customers ----------

export type CustomerInput = Pick<Customer, 'name' | 'email' | 'company' | 'plan' | 'status' | 'country' | 'seats' | 'ownerId'> & {
  id?: number
}

export const customers = {
  list: (db: DB, p: ListParams) =>
    list<Customer>(db, 'customers', customerColumns, select(customerColumns), p, ['name', 'email', 'company']),
  get: (db: DB, id: number): Customer | undefined =>
    db.prepare(`SELECT ${select(customerColumns)} FROM customers WHERE id = ?`).get(id) as Customer | undefined,
  create: (db: DB, input: CustomerInput, mrr: number): Customer => {
    const ts = now()
    const res = db
      .prepare(
        `INSERT INTO customers (id, name, email, company, plan, status, country, seats, mrr, owner_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id ?? null,
        input.name,
        input.email,
        input.company,
        input.plan,
        input.status,
        input.country,
        input.seats,
        mrr,
        input.ownerId,
        ts,
        ts,
      )
    return customers.get(db, Number(res.lastInsertRowid))!
  },
  update: (db: DB, id: number, patch: Partial<CustomerInput> & { mrr?: number }): Customer | undefined => {
    const sets = setClause(patch, {
      name: 'name',
      email: 'email',
      company: 'company',
      plan: 'plan',
      status: 'status',
      country: 'country',
      seats: 'seats',
      mrr: 'mrr',
      ownerId: 'owner_id',
    })
    if (sets.sql) db.prepare(`UPDATE customers SET ${sets.sql}, updated_at = ? WHERE id = ?`).run(...sets.params, now(), id)
    return customers.get(db, id)
  },
  remove: (db: DB, id: number) => db.prepare(`DELETE FROM customers WHERE id = ?`).run(id).changes > 0,
}

// ---------- invoices ----------

export const invoices = {
  list: (db: DB, p: ListParams) => list<Invoice>(db, 'invoices', invoiceColumns, select(invoiceColumns), p, ['number']),
  get: (db: DB, id: number): Invoice | undefined =>
    db.prepare(`SELECT ${select(invoiceColumns)} FROM invoices WHERE id = ?`).get(id) as Invoice | undefined,
  update: (db: DB, id: number, patch: Partial<Pick<Invoice, 'status' | 'paidAt'>>): Invoice | undefined => {
    const sets = setClause(patch, { status: 'status', paidAt: 'paid_at' })
    if (sets.sql) db.prepare(`UPDATE invoices SET ${sets.sql} WHERE id = ?`).run(...sets.params, id)
    return invoices.get(db, id)
  },
}

// ---------- projects ----------

export const projects = {
  list: (db: DB, p: ListParams) =>
    list<Project & { taskCount: number; doneCount: number }>(db, 'projects', projectColumns, projectSelect, p, ['name']),
  get: (db: DB, id: number): Project | undefined =>
    db.prepare(`SELECT ${projectSelect} FROM projects WHERE id = ?`).get(id) as Project | undefined,
  update: (db: DB, id: number, patch: Partial<Pick<Project, 'name' | 'description' | 'status' | 'ownerId'>>) => {
    const sets = setClause(patch, { name: 'name', description: 'description', status: 'status', ownerId: 'owner_id' })
    if (sets.sql) db.prepare(`UPDATE projects SET ${sets.sql} WHERE id = ?`).run(...sets.params, id)
    return projects.get(db, id)
  },
}

// ---------- tasks ----------

export type TaskInput = Pick<Task, 'projectId' | 'title' | 'status' | 'priority' | 'assigneeId' | 'dueDate'> & {
  id?: number
  position?: number
}

export const tasks = {
  list: (db: DB, p: ListParams) => list<Task>(db, 'tasks', taskColumns, select(taskColumns), p, ['title']),
  get: (db: DB, id: number): Task | undefined =>
    db.prepare(`SELECT ${select(taskColumns)} FROM tasks WHERE id = ?`).get(id) as Task | undefined,
  create: (db: DB, input: TaskInput): Task => {
    const ts = now()
    const position =
      input.position ??
      (
        db.prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE project_id = ?`).get(input.projectId) as {
          p: number
        }
      ).p
    const res = db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, status, priority, assignee_id, due_date, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id ?? null,
        input.projectId,
        input.title,
        input.status,
        input.priority,
        input.assigneeId,
        input.dueDate,
        position,
        ts,
        ts,
      )
    return tasks.get(db, Number(res.lastInsertRowid))!
  },
  update: (db: DB, id: number, patch: Partial<TaskInput>) => {
    const sets = setClause(patch, {
      title: 'title',
      status: 'status',
      priority: 'priority',
      assigneeId: 'assignee_id',
      dueDate: 'due_date',
      position: 'position',
      projectId: 'project_id',
    })
    if (sets.sql) db.prepare(`UPDATE tasks SET ${sets.sql}, updated_at = ? WHERE id = ?`).run(...sets.params, now(), id)
    return tasks.get(db, id)
  },
  remove: (db: DB, id: number) => db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id).changes > 0,
}

// ---------- events ----------

export const events = {
  list: (db: DB, p: ListParams) => list<ActivityEvent>(db, 'events', eventColumns, `${select(eventColumns)}, message`, p, []),
  page: (db: DB, cursor: number | null, limit: number, type?: string): CursorPage<ActivityEvent> => {
    const clauses: string[] = []
    const params: unknown[] = []
    if (cursor) {
      clauses.push('id < ?')
      params.push(cursor)
    }
    if (type) {
      clauses.push('type LIKE ?')
      params.push(`${type}%`)
    }
    const rows = db
      .prepare(
        `SELECT ${select(eventColumns)}, message FROM events ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit + 1) as ActivityEvent[]
    const hasMore = rows.length > limit
    const data = rows.slice(0, limit)
    return { data, nextCursor: hasMore ? data[data.length - 1]!.id : null }
  },
  record: (db: DB, e: Omit<ActivityEvent, 'id' | 'createdAt'>): ActivityEvent => {
    const res = db
      .prepare(`INSERT INTO events (type, actor_id, customer_id, message, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(e.type, e.actorId, e.customerId, e.message, now())
    return db
      .prepare(`SELECT ${select(eventColumns)}, message FROM events WHERE id = ?`)
      .get(res.lastInsertRowid) as ActivityEvent
  },
}

// ---------- metrics (server-side aggregation; what a "classic" app does) ----------

export const metrics = {
  overview: (db: DB): OverviewMetrics => {
    const c = db
      .prepare(
        `SELECT
          COALESCE(SUM(CASE WHEN status = 'active' THEN mrr END), 0) AS mrr,
          SUM(status = 'active') AS active,
          SUM(status = 'trial') AS trial,
          SUM(status = 'churned') AS churned,
          COUNT(*) AS total
         FROM customers`,
      )
      .get() as { mrr: number; active: number; trial: number; churned: number; total: number }
    const inv = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status IN ('open','overdue') THEN amount END), 0) AS outstanding,
                SUM(status = 'overdue') AS overdue FROM invoices`,
      )
      .get() as { outstanding: number; overdue: number }
    const t = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status != 'done'`).get() as { n: number }
    return {
      mrr: c.mrr,
      arr: c.mrr * 12,
      activeCustomers: c.active ?? 0,
      trialCustomers: c.trial ?? 0,
      churnedCustomers: c.churned ?? 0,
      totalCustomers: c.total,
      outstanding: inv.outstanding,
      overdueCount: inv.overdue ?? 0,
      openTasks: t.n,
      arpa: c.active ? Math.round(c.mrr / c.active) : 0,
    }
  },
  revenue: (db: DB, months: number): RevenuePoint[] =>
    db
      .prepare(
        `SELECT substr(COALESCE(paid_at, issued_at), 1, 7) AS month, SUM(amount) AS revenue, COUNT(*) AS invoices
         FROM invoices WHERE status = 'paid' AND substr(COALESCE(paid_at, issued_at), 1, 7) < strftime('%Y-%m', 'now')
         GROUP BY month ORDER BY month DESC LIMIT ?`,
      )
      .all(months)
      .reverse() as RevenuePoint[],
  signups: (db: DB, months: number): SignupPoint[] => {
    const rows = db
      .prepare(
        `SELECT substr(created_at, 1, 7) AS month, plan, COUNT(*) AS count FROM customers
         WHERE substr(created_at, 1, 7) >= (SELECT substr(date('now', ?), 1, 7))
         GROUP BY month, plan ORDER BY month`,
      )
      .all(`-${months - 1} months`) as SignupPoint[]
    return rows
  },
  breakdown: (db: DB, by: 'plan' | 'country' | 'status'): BreakdownPoint[] =>
    db
      .prepare(
        `SELECT ${by} AS key, COUNT(*) AS customers, COALESCE(SUM(CASE WHEN status = 'active' THEN mrr END), 0) AS mrr
         FROM customers GROUP BY ${by} ORDER BY mrr DESC, customers DESC`,
      )
      .all() as BreakdownPoint[],
  workload: (db: DB) =>
    db
      .prepare(
        `SELECT u.id AS userId, u.name AS name,
                SUM(t.status != 'done') AS open, SUM(t.status = 'done') AS done
         FROM users u LEFT JOIN tasks t ON t.assignee_id = u.id
         GROUP BY u.id ORDER BY open DESC`,
      )
      .all() as Array<{ userId: number; name: string; open: number; done: number }>,
}

// ---------- helpers ----------

function setClause(patch: Record<string, unknown>, map: Record<string, string>) {
  const parts: string[] = []
  const params: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !(k in map)) continue
    parts.push(`${map[k]} = ?`)
    params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v)
  }
  return { sql: parts.join(', '), params }
}
