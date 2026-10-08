import {
  COUNTRIES,
  PERMISSIONS,
  PROJECT_STATUSES,
  ROLE_PERMISSIONS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Plan,
  type Role,
} from '../../shared/domain.ts'
import { hashPassword } from '../auth/password.ts'
import { markOverdue, rebuildMrrSnapshots } from './jobs.ts'
import { SCHEMA, TABLES, type DB } from './schema.ts'

/** Small deterministic PRNG (mulberry32) so seeds are reproducible in tests. */
export function rng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)]!,
    weighted: <T>(pairs: ReadonlyArray<readonly [T, number]>): T => {
      const total = pairs.reduce((s, [, w]) => s + w, 0)
      let r = next() * total
      for (const [v, w] of pairs) {
        if ((r -= w) <= 0) return v
      }
      return pairs[pairs.length - 1]![0]
    },
  }
}

const FIRST = [
  'Ada',
  'Alan',
  'Grace',
  'Linus',
  'Margaret',
  'Ken',
  'Barbara',
  'Dennis',
  'Radia',
  'Tim',
  'Frances',
  'Guido',
  'Hedy',
  'John',
  'Katherine',
  'Donald',
  'Sophie',
  'Yukihiro',
  'Anita',
  'Brendan',
  'Joan',
  'Bjarne',
  'Lynn',
  'James',
  'Mary',
  'Rich',
  'Evelyn',
  'Niklaus',
  'Carol',
  'Edsger',
]
const LAST = [
  'Lovelace',
  'Turing',
  'Hopper',
  'Torvalds',
  'Hamilton',
  'Thompson',
  'Liskov',
  'Ritchie',
  'Perlman',
  'Berners-Lee',
  'Allen',
  'van Rossum',
  'Lamarr',
  'McCarthy',
  'Johnson',
  'Knuth',
  'Wilson',
  'Matsumoto',
  'Borg',
  'Eich',
  'Clarke',
  'Stroustrup',
  'Conway',
  'Gosling',
  'Keller',
  'Hickey',
  'Boyd',
  'Wirth',
  'Shaw',
  'Dijkstra',
]
const CO_A = [
  'Acme',
  'Globex',
  'Initech',
  'Umbrella',
  'Hooli',
  'Vandelay',
  'Stark',
  'Wayne',
  'Wonka',
  'Cyberdyne',
  'Soylent',
  'Tyrell',
  'Aperture',
  'Pied Piper',
  'Massive',
  'Monarch',
  'Gringotts',
  'Oceanic',
  'Nakatomi',
  'Prestige',
  'Blue Sun',
  'Dunder',
  'Bluth',
  'Sterling',
  'Wernham',
  'Kramerica',
  'Oscorp',
  'Virtucon',
  'Yoyodyne',
  'Zorg',
]
const CO_B = [
  'Labs',
  'Systems',
  'Industries',
  'Analytics',
  'Cloud',
  'Dynamics',
  'Networks',
  'Health',
  'Logistics',
  'Robotics',
  'Capital',
  'Media',
  'Foods',
  'Energy',
  'Studio',
]
const TITLES = [
  'Account Executive',
  'Customer Success',
  'Solutions Engineer',
  'Support Lead',
  'Product Manager',
  'Engineer',
  'Designer',
  'Head of Sales',
]
const CONTACT_TITLES = ['CTO', 'VP Engineering', 'Head of IT', 'Procurement', 'CFO', 'Engineering Manager', 'Ops Lead', 'Founder']
const COLORS = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#84cc16', '#f97316', '#0ea5e9']
const PROJECT_WORDS = [
  'Onboarding',
  'Migration',
  'Integration',
  'Rollout',
  'Audit',
  'Dashboard',
  'Renewal',
  'Expansion',
  'Pilot',
  'SSO Setup',
  'Data Import',
  'Training',
]
const TASK_VERBS = [
  'Draft',
  'Review',
  'Ship',
  'Configure',
  'Test',
  'Document',
  'Schedule',
  'Migrate',
  'Design',
  'Fix',
  'Prepare',
  'Validate',
]
const TASK_NOUNS = [
  'kickoff deck',
  'SAML config',
  'billing export',
  'webhook retries',
  'usage report',
  'admin roles',
  'CSV import',
  'renewal quote',
  'QBR agenda',
  'API keys',
  'audit log',
  'onboarding email',
  'SLA terms',
  'sandbox env',
  'data mapping',
]
const COMMENTS = [
  'Looks good to me 👍',
  'Blocked on customer feedback.',
  'Pushed a first pass, please review.',
  'Can we move this to next sprint?',
  'Customer confirmed the scope.',
  'Added notes from the call.',
  'Done on our side, waiting for their IT.',
  'Escalated to the account owner.',
]
const TEAMS = [
  ['Enterprise Sales', 'Named accounts > 50 seats'],
  ['Mid-Market', 'Inbound and expansion for growing teams'],
  ['Customer Success', 'Onboarding, adoption and renewals'],
  ['Solutions Engineering', 'Technical discovery, pilots and integrations'],
  ['Support', 'Tier 1 and 2 support'],
] as const
const TAGS = [
  ['strategic', '#6366f1'],
  ['at-risk', '#ef4444'],
  ['expansion', '#14b8a6'],
  ['reference', '#f59e0b'],
  ['beta', '#8b5cf6'],
  ['regulated', '#0ea5e9'],
  ['partner', '#84cc16'],
  ['self-serve', '#64748b'],
] as const
const PRODUCTS: ReadonlyArray<{ sku: string; name: string; kind: 'plan' | 'addon'; planCode: Plan | null; unitPrice: number }> = [
  { sku: 'PLAN-FREE', name: 'Free plan', kind: 'plan', planCode: 'free', unitPrice: 0 },
  { sku: 'PLAN-STARTER', name: 'Starter plan', kind: 'plan', planCode: 'starter', unitPrice: 1900 },
  { sku: 'PLAN-PRO', name: 'Pro plan', kind: 'plan', planCode: 'pro', unitPrice: 4900 },
  { sku: 'PLAN-ENT', name: 'Enterprise plan', kind: 'plan', planCode: 'enterprise', unitPrice: 12900 },
  { sku: 'ADD-SSO', name: 'SSO & SCIM add-on', kind: 'addon', planCode: null, unitPrice: 400 },
  { sku: 'ADD-AUDIT', name: 'Advanced audit add-on', kind: 'addon', planCode: null, unitPrice: 300 },
  { sku: 'ADD-SUPPORT', name: 'Priority support', kind: 'addon', planCode: null, unitPrice: 49900 },
  { sku: 'ADD-STORAGE', name: 'Extra storage (100 GB)', kind: 'addon', planCode: null, unitPrice: 2500 },
]
export const PLAN_PRODUCT_ID: Record<Plan, number> = { free: 1, starter: 2, pro: 3, enterprise: 4 }

/** Fixed demo accounts, one per role. Password for every seeded user: "password". */
export const DEMO_USERS: ReadonlyArray<{ email: string; name: string; role: Role; title: string }> = [
  { email: 'owner@saasly.dev', name: 'Ada Lovelace', role: 'owner', title: 'CEO' },
  { email: 'admin@saasly.dev', name: 'Grace Hopper', role: 'admin', title: 'Head of Operations' },
  { email: 'billing@saasly.dev', name: 'Frances Allen', role: 'billing', title: 'Finance Manager' },
  { email: 'member@saasly.dev', name: 'Linus Torvalds', role: 'member', title: 'Account Executive' },
  { email: 'viewer@saasly.dev', name: 'Barbara Liskov', role: 'viewer', title: 'Board Observer' },
]
export const DEMO_PASSWORD = 'password'

export interface SeedOptions {
  seed?: number
  users?: number
  customers?: number
  projects?: number
  events?: number
  usageDays?: number
  /** Reference "now" so the data always looks recent. */
  now?: Date
}

const iso = (d: Date) => d.toISOString()
const day = 24 * 3600 * 1000

/** Drop every table/view/trigger and recreate the schema (append-only triggers forbid DELETE). */
export function resetSchema(db: DB) {
  db.pragma('foreign_keys = OFF')
  db.exec('DROP VIEW IF EXISTS project_stats; DROP VIEW IF EXISTS customer_health;')
  for (const t of [...TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS ${t}`)
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
}

export function seed(db: DB, opts: SeedOptions = {}) {
  resetSchema(db)
  const r = rng(opts.seed ?? 42)
  const now = opts.now ?? new Date()
  const nUsers = Math.max(opts.users ?? 24, DEMO_USERS.length)
  const nCustomers = opts.customers ?? 1500
  const nProjects = opts.projects ?? 40
  const nEvents = opts.events ?? 3000
  const usageDays = opts.usageDays ?? 30
  const passwordHash = hashPassword(DEMO_PASSWORD, 'saasly-demo-salt')

  db.transaction(() => {
    // ---------------- RBAC ----------------
    const insRole = db.prepare(`INSERT INTO roles (id, name, description, rank) VALUES (?, ?, ?, ?)`)
    const roleInfo: Record<Role, [string, string]> = {
      owner: ['Owner', 'Full access including developer tools'],
      admin: ['Admin', 'Manage everything except developer tools'],
      billing: ['Billing', 'Finance: subscriptions, invoices and payments'],
      member: ['Member', 'Day-to-day work on owned accounts and team projects'],
      viewer: ['Viewer', 'Read-only access'],
    }
    ;(Object.keys(roleInfo) as Role[]).forEach((id, i) => insRole.run(id, roleInfo[id][0], roleInfo[id][1], i))
    const insPerm = db.prepare(`INSERT INTO permissions (id, description) VALUES (?, ?)`)
    for (const [id, desc] of Object.entries(PERMISSIONS)) insPerm.run(id, desc)
    const insRP = db.prepare(`INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)`)
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) for (const p of perms) insRP.run(role, p)

    // ---------------- users & teams ----------------
    const insUser = db.prepare(
      `INSERT INTO users (id, name, email, role, title, avatar_color, active, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (let i = 1; i <= nUsers; i++) {
      const demo = DEMO_USERS[i - 1]
      const first = FIRST[(i - 1) % FIRST.length]!
      const last = LAST[(i * 7) % LAST.length]!
      const role: Role =
        demo?.role ??
        r.weighted([
          ['admin', 1],
          ['billing', 1],
          ['member', 8],
          ['viewer', 2],
        ] as const)
      insUser.run(
        i,
        demo?.name ?? `${first} ${last}`,
        demo?.email ?? `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + `${i}@saasly.dev`,
        role,
        demo?.title ?? r.pick(TITLES),
        r.pick(COLORS),
        demo || r.next() < 0.92 ? 1 : 0,
        passwordHash,
        iso(new Date(now.getTime() - r.int(200, 900) * day)),
      )
    }
    const insTeam = db.prepare(`INSERT INTO teams (id, name, description, lead_id, created_at) VALUES (?, ?, ?, ?, ?)`)
    const insMember = db.prepare(`INSERT OR IGNORE INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)`)
    TEAMS.forEach(([name, desc], i) => insTeam.run(i + 1, name, desc, null, iso(new Date(now.getTime() - 800 * day))))
    const teamOf = new Map<number, number>()
    for (let u = 1; u <= nUsers; u++) {
      const primary = u === 4 ? 1 : ((u - 1) % TEAMS.length) + 1 // member@ sells enterprise
      teamOf.set(u, primary)
      insMember.run(primary, u, iso(new Date(now.getTime() - r.int(30, 600) * day)))
      if (r.next() < 0.3) insMember.run(r.int(1, TEAMS.length), u, iso(new Date(now.getTime() - r.int(30, 600) * day)))
    }
    db.prepare(
      `UPDATE teams SET lead_id = (SELECT MIN(user_id) FROM team_members WHERE team_id = teams.id AND user_id > 5)`,
    ).run()

    // ---------------- catalog & tags ----------------
    const insProduct = db.prepare(
      `INSERT INTO products (id, sku, name, kind, plan_code, unit_price, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    PRODUCTS.forEach((p, i) =>
      insProduct.run(i + 1, p.sku, p.name, p.kind, p.planCode, p.unitPrice, iso(new Date(now.getTime() - 900 * day))),
    )
    const insTag = db.prepare(`INSERT INTO tags (id, name, color) VALUES (?, ?, ?)`)
    TAGS.forEach(([name, color], i) => insTag.run(i + 1, name, color))

    // ---------------- customers, contacts, subscriptions, invoices, payments ----------------
    const insCustomer = db.prepare(
      `INSERT INTO customers (id, name, email, company, plan, status, country, seats, mrr, owner_id, team_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    const insContact = db.prepare(
      `INSERT INTO contacts (customer_id, name, email, title, is_primary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const insCustomerTag = db.prepare(`INSERT OR IGNORE INTO customer_tags (customer_id, tag_id, tagged_at) VALUES (?, ?, ?)`)
    const insSub = db.prepare(
      `INSERT INTO subscriptions (customer_id, product_id, quantity, unit_price, status, started_at, canceled_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    // history flows through the same triggers as live writes: one net MRR movement per
    // signup (held while its subscriptions are inserted) and one per churn
    const holdMrr = db.prepare(
      `INSERT INTO mrr_hold (customer_id, mrr_before, at) VALUES (@id, (SELECT mrr FROM customers WHERE id = @id), @at)`,
    )
    const releaseMrr = db.prepare(`DELETE FROM mrr_hold WHERE customer_id = ?`)
    const cancelSubs = db.prepare(
      `UPDATE subscriptions SET status = 'canceled', canceled_at = ? WHERE customer_id = ? AND status != 'canceled'`,
    )
    const insInvoice = db.prepare(
      `INSERT INTO invoices (number, customer_id, status, issued_at, due_at, paid_at) VALUES (?, ?, 'open', ?, ?, NULL)`,
    )
    const insLine = db.prepare(
      `INSERT INTO invoice_line_items (invoice_id, product_id, description, quantity, unit_amount, amount) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const insPayment = db.prepare(
      `INSERT INTO payments (invoice_id, customer_id, amount, method, reference, received_at, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const voidInvoice = db.prepare(`UPDATE invoices SET status = 'void' WHERE id = ?`)
    let invoiceNo = 1000
    for (let i = 1; i <= nCustomers; i++) {
      const first = r.pick(FIRST)
      const last = r.pick(LAST)
      const company = `${r.pick(CO_A)} ${r.pick(CO_B)}`
      const domain = company.toLowerCase().replace(/[^a-z]/g, '')
      const plan: Plan = r.weighted([
        ['free', 25],
        ['starter', 35],
        ['pro', 28],
        ['enterprise', 12],
      ] as const)
      const ageDays = Math.floor(Math.pow(r.next(), 1.6) * 540)
      const created = new Date(now.getTime() - ageDays * day - r.int(0, 86_000) * 1000)
      const status = ageDays < 14 && r.next() < 0.6 ? 'trial' : r.next() < 0.12 ? 'churned' : 'active'
      const seats =
        plan === 'enterprise' ? r.int(20, 250) : plan === 'pro' ? r.int(5, 60) : plan === 'starter' ? r.int(1, 15) : r.int(1, 3)
      const ownerId = r.next() < 0.9 ? r.int(1, nUsers) : null
      insCustomer.run(
        i,
        `${first} ${last}`,
        `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + `@${domain}.com`,
        company,
        plan,
        status,
        r.pick(COUNTRIES),
        seats,
        ownerId,
        ownerId ? teamOf.get(ownerId)! : null,
        iso(created),
        iso(new Date(created.getTime() + r.int(0, ageDays) * day)),
      )
      // contacts
      const nContacts = r.int(1, plan === 'enterprise' ? 4 : 2)
      for (let c = 0; c < nContacts; c++) {
        const cf = c === 0 ? first : r.pick(FIRST)
        const cl = c === 0 ? last : r.pick(LAST)
        insContact.run(
          i,
          `${cf} ${cl}`,
          `${cf}.${cl}`.toLowerCase().replace(/[^a-z.]/g, '') + `@${domain}.com`,
          r.pick(CONTACT_TITLES),
          c === 0 ? 1 : 0,
          iso(created),
        )
      }
      // tags
      for (let t = r.int(0, 2); t > 0; t--) insCustomerTag.run(i, r.int(1, TAGS.length), iso(created))
      if (status === 'churned') insCustomerTag.run(i, 2, iso(created))

      // subscriptions (base plan + add-ons)
      const months = Math.floor(ageDays / 30)
      const churnMonth = status === 'churned' ? Math.max(1, Math.floor(months * r.next())) : null
      // (never in the future: a churned account churned by now)
      const canceledAt =
        churnMonth !== null ? iso(new Date(Math.min(created.getTime() + churnMonth * 30 * day, now.getTime()))) : null
      const subStatus = status === 'trial' ? 'trialing' : status === 'churned' ? 'canceled' : 'active'
      const base = PRODUCTS[PLAN_PRODUCT_ID[plan] - 1]!
      const lines: Array<{ productId: number; quantity: number; unitPrice: number; name: string }> = [
        { productId: PLAN_PRODUCT_ID[plan], quantity: seats, unitPrice: base.unitPrice, name: base.name },
      ]
      if (plan === 'enterprise' || (plan === 'pro' && r.next() < 0.4)) {
        if (r.next() < 0.7) lines.push({ productId: 5, quantity: seats, unitPrice: 400, name: PRODUCTS[4]!.name })
        if (r.next() < 0.3) lines.push({ productId: 6, quantity: seats, unitPrice: 300, name: PRODUCTS[5]!.name })
        if (plan === 'enterprise' && r.next() < 0.4)
          lines.push({ productId: 7, quantity: 1, unitPrice: 49900, name: PRODUCTS[6]!.name })
      }
      if (r.next() < 0.1) lines.push({ productId: 8, quantity: r.int(1, 5), unitPrice: 2500, name: PRODUCTS[7]!.name })
      holdMrr.run({ id: i, at: iso(created) })
      for (const l of lines)
        insSub.run(i, l.productId, l.quantity, l.unitPrice, subStatus === 'canceled' ? 'active' : subStatus, iso(created), null)
      releaseMrr.run(i)
      if (canceledAt !== null) {
        holdMrr.run({ id: i, at: canceledAt })
        cancelSubs.run(canceledAt, i)
        releaseMrr.run(i)
      }

      // monthly invoices with line items; payments settle them (trigger)
      if (plan !== 'free' && status !== 'trial') {
        const billedMonths = Math.min(churnMonth ?? months, 18)
        for (let m = 0; m < billedMonths; m++) {
          const issued = new Date(created.getTime() + (m + 1) * 30 * day)
          if (issued > now) break
          const due = new Date(issued.getTime() + 14 * day)
          const res = insInvoice.run(`INV-${invoiceNo++}`, i, iso(issued), iso(due))
          const invoiceId = Number(res.lastInsertRowid)
          let total = 0
          for (const l of lines) {
            const qty = l.productId <= 4 ? Math.max(1, Math.round(l.quantity * (0.9 + r.next() * 0.2))) : l.quantity
            insLine.run(
              invoiceId,
              l.productId,
              `${l.name} — ${issued.toISOString().slice(0, 7)}`,
              qty,
              l.unitPrice,
              qty * l.unitPrice,
            )
            total += qty * l.unitPrice
          }
          const recent = now.getTime() - issued.getTime() < 45 * day
          const outcome = recent
            ? due > now
              ? r.weighted([
                  ['paid', 6],
                  ['open', 4],
                ] as const)
              : r.weighted([
                  ['paid', 7],
                  ['open', 3],
                ] as const)
            : r.weighted([
                ['paid', 97],
                ['void', 3],
              ] as const)
          if (outcome === 'void') voidInvoice.run(invoiceId)
          else if (outcome === 'paid') {
            const paidAt = new Date(Math.min(issued.getTime() + r.int(0, 20) * day, now.getTime()))
            // some customers pay in two instalments
            if (r.next() < 0.05 && total > 1000) {
              const half = Math.floor(total / 2)
              insPayment.run(invoiceId, i, half, 'wire', `WIRE-${invoiceId}-1`, iso(new Date(paidAt.getTime() - 3 * day)), null)
              insPayment.run(invoiceId, i, total - half, 'wire', `WIRE-${invoiceId}-2`, iso(paidAt), null)
            } else {
              const method = r.weighted([
                ['card', 7],
                ['ach', 2],
                ['wire', 1],
              ] as const)
              insPayment.run(invoiceId, i, total, method, `${method.toUpperCase()}-${invoiceId}`, iso(paidAt), null)
            }
          }
        }
      }
    }

    // ---------------- usage metering (append-only events -> daily rollup via trigger) ----------------
    const insUsage = db.prepare(
      `INSERT INTO usage_events (customer_id, metric, quantity, occurred_at, idempotency_key) VALUES (?, ?, ?, ?, ?)`,
    )
    const metered = db.prepare(`SELECT id, plan, seats FROM customers WHERE status != 'churned'`).all() as Array<{
      id: number
      plan: Plan
      seats: number
    }>
    for (const c of metered) {
      const intensity = { free: 50, starter: 400, pro: 2500, enterprise: 15000 }[c.plan]
      const dormant = r.next() < 0.08
      for (let d = usageDays; d >= 1; d--) {
        if (dormant && d < usageDays - 5) break
        const at = new Date(now.getTime() - d * day + r.int(0, 80_000) * 1000)
        insUsage.run(c.id, 'api_calls', Math.round(intensity * (0.5 + r.next())), iso(at), `seed-${c.id}-api-${d}`)
        if (d % 7 === 0)
          insUsage.run(
            c.id,
            'storage_gb',
            Math.max(1, Math.round(c.seats * 0.4 * (0.8 + r.next() * 0.4))),
            iso(at),
            `seed-${c.id}-sto-${d}`,
          )
      }
    }

    // ---------------- projects, tasks, comments, time ----------------
    const insProject = db.prepare(
      `INSERT INTO projects (id, name, description, customer_id, owner_id, team_id, status, budget_hours, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insTask = db.prepare(
      `INSERT INTO tasks (project_id, title, status, priority, assignee_id, due_date, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insComment = db.prepare(`INSERT INTO task_comments (task_id, author_id, body, created_at) VALUES (?, ?, ?, ?)`)
    const insTime = db.prepare(
      `INSERT INTO time_entries (task_id, user_id, minutes, spent_on, billable, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    for (let p = 1; p <= nProjects; p++) {
      const customerId = r.int(1, nCustomers)
      const created = new Date(now.getTime() - r.int(5, 200) * day)
      const ownerId = p <= 3 ? 4 : r.int(1, nUsers)
      insProject.run(
        p,
        `${r.pick(CO_A)} ${r.pick(PROJECT_WORDS)}`,
        `Work stream to deliver ${r.pick(PROJECT_WORDS).toLowerCase()} for the account.`,
        customerId,
        ownerId,
        p <= 3 ? 1 : r.int(1, TEAMS.length),
        r.weighted([
          [PROJECT_STATUSES[0], 2],
          [PROJECT_STATUSES[1], 6],
          [PROJECT_STATUSES[2], 1],
          [PROJECT_STATUSES[3], 2],
        ] as const),
        r.int(4, 30) * 10,
        iso(created),
      )
      const nTasks = r.int(6, 22)
      for (let t = 0; t < nTasks; t++) {
        const tCreated = new Date(created.getTime() + r.int(0, 5) * day)
        const assignee = r.next() < 0.85 ? r.int(1, nUsers) : null
        const res = insTask.run(
          p,
          `${r.pick(TASK_VERBS)} ${r.pick(TASK_NOUNS)}`,
          r.weighted([
            [TASK_STATUSES[0], 4],
            [TASK_STATUSES[1], 3],
            [TASK_STATUSES[2], 1],
            [TASK_STATUSES[3], 4],
          ] as const),
          r.weighted([
            [TASK_PRIORITIES[0], 3],
            [TASK_PRIORITIES[1], 5],
            [TASK_PRIORITIES[2], 2],
            [TASK_PRIORITIES[3], 1],
          ] as const),
          assignee,
          r.next() < 0.7 ? iso(new Date(now.getTime() + r.int(-10, 40) * day)).slice(0, 10) : null,
          t + 1,
          iso(tCreated),
          iso(tCreated),
        )
        const taskId = Number(res.lastInsertRowid)
        for (
          let c = r.weighted([
            [0, 4],
            [1, 3],
            [2, 2],
            [3, 1],
          ] as const);
          c > 0;
          c--
        )
          insComment.run(
            taskId,
            r.int(1, nUsers),
            r.pick(COMMENTS),
            iso(new Date(Math.min(tCreated.getTime() + r.int(1, 20) * day, now.getTime()))),
          )
        if (assignee)
          for (let e = r.int(0, 4); e > 0; e--) {
            const spent = new Date(Math.min(tCreated.getTime() + r.int(0, 30) * day, now.getTime()))
            insTime.run(taskId, assignee, r.int(1, 16) * 15, iso(spent).slice(0, 10), r.next() < 0.75 ? 1 : 0, '', iso(spent))
          }
      }
    }

    // ---------------- activity feed ----------------
    const insEvent = db.prepare(`INSERT INTO events (type, actor_id, customer_id, message, created_at) VALUES (?, ?, ?, ?, ?)`)
    const evTimes = Array.from({ length: nEvents }, () => now.getTime() - Math.floor(Math.pow(r.next(), 2) * 120 * day)).sort(
      (a, b) => a - b,
    )
    for (const t of evTimes) {
      const type = r.weighted([
        ['customer.created', 3],
        ['customer.updated', 4],
        ['invoice.paid', 5],
        ['invoice.created', 3],
        ['task.updated', 6],
        ['task.created', 3],
        ['comment.created', 2],
      ] as const)
      const customerId = r.int(1, nCustomers)
      const message =
        type === 'customer.created'
          ? `New customer signed up (#${customerId})`
          : type === 'customer.updated'
            ? `Updated customer #${customerId}`
            : type === 'invoice.paid'
              ? `Invoice paid by customer #${customerId}`
              : type === 'invoice.created'
                ? `Invoice issued to customer #${customerId}`
                : type === 'task.created'
                  ? `Created task "${r.pick(TASK_VERBS)} ${r.pick(TASK_NOUNS)}"`
                  : type === 'comment.created'
                    ? `Commented: "${r.pick(COMMENTS)}"`
                    : `Moved task "${r.pick(TASK_VERBS)} ${r.pick(TASK_NOUNS)}"`
      insEvent.run(
        type,
        r.int(1, nUsers),
        type.startsWith('task') || type.startsWith('comment') ? null : customerId,
        message,
        iso(new Date(t)),
      )
    }

    // ---------------- audit history & notifications ----------------
    const insAudit = db.prepare(
      `INSERT INTO audit_log (at, actor_id, action, entity, entity_id, changes, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const auditTimes = Array.from({ length: 400 }, () => now.getTime() - r.int(1, 90 * 24) * 3600 * 1000).sort((a, b) => a - b)
    auditTimes.forEach((t, a) => {
      const at = iso(new Date(t))
      const kind = r.weighted([
        ['login', 3],
        ['customer', 4],
        ['task', 3],
        ['subscription', 1],
      ] as const)
      if (kind === 'login') insAudit.run(at, r.int(1, nUsers), 'login', 'sessions', null, '{}', `seed-${a}`)
      else if (kind === 'customer')
        insAudit.run(
          at,
          r.int(1, nUsers),
          'update',
          'customers',
          r.int(1, nCustomers),
          JSON.stringify({ seats: [r.int(1, 20), r.int(1, 40)] }),
          `seed-${a}`,
        )
      else if (kind === 'task')
        insAudit.run(
          at,
          r.int(1, nUsers),
          'update',
          'tasks',
          r.int(1, 400),
          JSON.stringify({ status: ['todo', 'in_progress'] }),
          `seed-${a}`,
        )
      else insAudit.run(at, 3, 'update', 'subscriptions', r.int(1, 2000), JSON.stringify({ quantity: [10, 12] }), `seed-${a}`)
    })
    const insNote = db.prepare(
      `INSERT INTO notifications (user_id, kind, title, body, entity, entity_id, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (let u = 1; u <= 5; u++)
      for (let n = 0; n < 6; n++) {
        const at = iso(new Date(now.getTime() - r.int(1, 14 * 24) * 3600 * 1000))
        const cid = r.int(1, nCustomers)
        const kind = r.pick(['mention', 'invoice.overdue', 'assignment'] as const)
        const title = { mention: 'You were mentioned', 'invoice.overdue': 'Invoice overdue', assignment: 'New task assigned' }[
          kind
        ]
        insNote.run(u, kind, title, `Regarding customer #${cid}`, 'customers', cid, at, n > 2 ? at : null)
      }
  })()

  markOverdue(db, now)
  rebuildMrrSnapshots(db, 18, now)
}
