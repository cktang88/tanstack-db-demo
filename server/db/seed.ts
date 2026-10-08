import { COUNTRIES, PLAN_PRICE, PROJECT_STATUSES, ROLES, TASK_PRIORITIES, TASK_STATUSES, type Plan } from '../../shared/domain.ts'
import type { DB } from './schema.ts'

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

export interface SeedOptions {
  seed?: number
  users?: number
  customers?: number
  projects?: number
  events?: number
  /** Reference "now" so the data always looks recent. */
  now?: Date
}

const iso = (d: Date) => d.toISOString()
const day = 24 * 3600 * 1000

export function seed(db: DB, opts: SeedOptions = {}) {
  const r = rng(opts.seed ?? 42)
  const now = opts.now ?? new Date()
  const nUsers = opts.users ?? 24
  const nCustomers = opts.customers ?? 1500
  const nProjects = opts.projects ?? 40
  const nEvents = opts.events ?? 3000

  const tx = db.transaction(() => {
    db.exec(
      'DELETE FROM events; DELETE FROM tasks; DELETE FROM projects; DELETE FROM invoices; DELETE FROM customers; DELETE FROM users;',
    )

    const insUser = db.prepare(
      `INSERT INTO users (id, name, email, role, title, avatar_color, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (let i = 1; i <= nUsers; i++) {
      const first = FIRST[(i - 1) % FIRST.length]!
      const last = LAST[(i * 7) % LAST.length]!
      const role =
        i === 1
          ? 'owner'
          : r.weighted([
              [ROLES[1], 2],
              [ROLES[2], 8],
              [ROLES[3], 2],
            ] as const)
      insUser.run(
        i,
        `${first} ${last}`,
        `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + `${i}@saasly.dev`,
        role,
        r.pick(TITLES),
        r.pick(COLORS),
        r.next() < 0.92 ? 1 : 0,
        iso(new Date(now.getTime() - r.int(200, 900) * day)),
      )
    }

    const insCustomer = db.prepare(
      `INSERT INTO customers (id, name, email, company, plan, status, country, seats, mrr, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insInvoice = db.prepare(
      `INSERT INTO invoices (number, customer_id, amount, status, issued_at, due_at, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    let invoiceNo = 1000
    for (let i = 1; i <= nCustomers; i++) {
      const first = r.pick(FIRST)
      const last = r.pick(LAST)
      const company = `${r.pick(CO_A)} ${r.pick(CO_B)}`
      const plan: Plan = r.weighted([
        ['free', 25],
        ['starter', 35],
        ['pro', 28],
        ['enterprise', 12],
      ] as const)
      // signups skew to recent months -> growth curve
      const ageDays = Math.floor(Math.pow(r.next(), 1.6) * 540)
      const created = new Date(now.getTime() - ageDays * day - r.int(0, 86_000) * 1000)
      const status = ageDays < 14 && r.next() < 0.6 ? 'trial' : r.next() < 0.12 ? 'churned' : 'active'
      const seats =
        plan === 'enterprise' ? r.int(20, 250) : plan === 'pro' ? r.int(5, 60) : plan === 'starter' ? r.int(1, 15) : r.int(1, 3)
      const mrr = status === 'active' ? PLAN_PRICE[plan] * seats : 0
      insCustomer.run(
        i,
        `${first} ${last}`,
        `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '') + `@${company.toLowerCase().replace(/[^a-z]/g, '')}.com`,
        company,
        plan,
        status,
        r.pick(COUNTRIES),
        seats,
        mrr,
        r.next() < 0.9 ? r.int(1, nUsers) : null,
        iso(created),
        iso(new Date(created.getTime() + r.int(0, ageDays) * day)),
      )

      // Monthly invoices for paying customers.
      if (plan !== 'free' && status !== 'trial') {
        const months = Math.floor(ageDays / 30)
        const churnAt = status === 'churned' ? Math.max(1, Math.floor(months * r.next())) : months
        for (let m = 0; m < Math.min(churnAt, 18); m++) {
          const issued = new Date(created.getTime() + (m + 1) * 30 * day)
          if (issued > now) break
          const due = new Date(issued.getTime() + 14 * day)
          const recent = now.getTime() - issued.getTime() < 45 * day
          const status = recent
            ? due > now
              ? r.weighted([
                  ['paid', 6],
                  ['open', 4],
                ] as const)
              : r.weighted([
                  ['paid', 7],
                  ['overdue', 3],
                ] as const)
            : r.weighted([
                ['paid', 97],
                ['void', 3],
              ] as const)
          const amount = Math.round(PLAN_PRICE[plan] * seats * (0.9 + r.next() * 0.2))
          insInvoice.run(
            `INV-${invoiceNo++}`,
            i,
            amount,
            status,
            iso(issued),
            iso(due),
            status === 'paid' ? iso(new Date(issued.getTime() + r.int(0, 20) * day)) : null,
          )
        }
      }
    }

    const insProject = db.prepare(
      `INSERT INTO projects (id, name, description, customer_id, owner_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const insTask = db.prepare(
      `INSERT INTO tasks (project_id, title, status, priority, assignee_id, due_date, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (let p = 1; p <= nProjects; p++) {
      const customerId = r.int(1, nCustomers)
      const created = new Date(now.getTime() - r.int(5, 200) * day)
      insProject.run(
        p,
        `${r.pick(CO_A)} ${r.pick(PROJECT_WORDS)}`,
        `Work stream to deliver ${r.pick(PROJECT_WORDS).toLowerCase()} for the account.`,
        customerId,
        r.int(1, nUsers),
        r.weighted([
          [PROJECT_STATUSES[0], 2],
          [PROJECT_STATUSES[1], 6],
          [PROJECT_STATUSES[2], 1],
          [PROJECT_STATUSES[3], 2],
        ] as const),
        iso(created),
      )
      const nTasks = r.int(6, 22)
      for (let t = 0; t < nTasks; t++) {
        const tCreated = new Date(created.getTime() + r.int(0, 5) * day)
        insTask.run(
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
          r.next() < 0.85 ? r.int(1, nUsers) : null,
          r.next() < 0.7 ? iso(new Date(now.getTime() + r.int(-10, 40) * day)).slice(0, 10) : null,
          t + 1,
          iso(tCreated),
          iso(tCreated),
        )
      }
    }

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
      ] as const)
      const customerId = r.int(1, nCustomers)
      const actor = r.int(1, nUsers)
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
                  : `Moved task "${r.pick(TASK_VERBS)} ${r.pick(TASK_NOUNS)}"`
      insEvent.run(type, actor, type.startsWith('task') ? null : customerId, message, iso(new Date(t)))
    }
  })
  tx()
}
