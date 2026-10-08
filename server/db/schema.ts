import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type DB = Database.Database

/**
 * Saasly schema (29 tables + 2 views).
 *
 *  identity & access   users, roles, permissions, role_permissions, sessions, teams, team_members
 *  CRM                 customers, contacts, tags, customer_tags
 *  catalog & billing   products, subscriptions, invoices, invoice_line_items, payments (ledger)
 *  delivery            projects, tasks, task_comments (append-only), time_entries
 *  metering            usage_events (append-only)
 *  rollups             customer_balances, usage_daily (trigger-maintained), mrr_snapshots (job-maintained)
 *  ledgers             mrr_movements (append-only, written by trigger on customers.mrr)
 *  logs                events (activity feed, append-only), audit_log (append-only), notifications
 *  views               project_stats, customer_health
 *
 * Business rules enforced *in the database* (so every write path obeys them):
 *  - customers.mrr is the sum of its active subscriptions (trigger)
 *  - every change of customers.mrr appends an MRR movement (trigger); mrr_hold
 *    lets one business operation (e.g. a plan change) record a single net movement
 *  - invoices.amount is the sum of its line items (trigger)
 *  - an invoice becomes `paid` once payments cover it (trigger)
 *  - customer_balances / usage_daily are rolled up incrementally (triggers)
 *  - append-only tables reject UPDATE and DELETE (triggers)
 */
export const SCHEMA = /* sql */ `
-- ============================== identity & access ==============================
CREATE TABLE IF NOT EXISTS roles (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  rank         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  id           TEXT PRIMARY KEY,
  description  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id        TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id  TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  role           TEXT NOT NULL REFERENCES roles(id),
  title          TEXT NOT NULL,
  avatar_color   TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  password_hash  TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS teams (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL,
  lead_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);

-- ============================== CRM ==============================
CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  company     TEXT NOT NULL,
  plan        TEXT NOT NULL,              -- denormalised from the base-plan subscription
  status      TEXT NOT NULL,
  country     TEXT NOT NULL,
  seats       INTEGER NOT NULL,           -- denormalised from the base-plan subscription
  mrr         INTEGER NOT NULL DEFAULT 0, -- rollup of active subscriptions (trigger)
  mrr_changed_at TEXT,                    -- effective time of the latest mrr change (internal, feeds mrr_movements)
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  team_id     INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT                        -- soft delete: billing history must survive
);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_owner ON customers(owner_id);
CREATE INDEX IF NOT EXISTS idx_customers_created ON customers(created_at);

CREATE TABLE IF NOT EXISTS contacts (
  id           INTEGER PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  title        TEXT NOT NULL,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_customer ON contacts(customer_id);

CREATE TABLE IF NOT EXISTS tags (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  color  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_tags (
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  tag_id       INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  tagged_at    TEXT NOT NULL,
  PRIMARY KEY (customer_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_customer_tags_tag ON customer_tags(tag_id);

-- ============================== catalog & billing ==============================
CREATE TABLE IF NOT EXISTS products (
  id           INTEGER PRIMARY KEY,
  sku          TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,       -- 'plan' | 'addon'
  plan_code    TEXT,                -- free/starter/pro/enterprise for kind = 'plan'
  unit_price   INTEGER NOT NULL,    -- cents per unit per month
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id           INTEGER PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  product_id   INTEGER NOT NULL REFERENCES products(id),
  quantity     INTEGER NOT NULL,
  unit_price   INTEGER NOT NULL,    -- price locked in at signup
  status       TEXT NOT NULL,       -- trialing | active | past_due | canceled
  started_at   TEXT NOT NULL,
  canceled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id);

CREATE TABLE IF NOT EXISTS invoices (
  id           INTEGER PRIMARY KEY,
  number       TEXT NOT NULL UNIQUE,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  amount       INTEGER NOT NULL DEFAULT 0,  -- rollup of line items (trigger)
  status       TEXT NOT NULL,
  issued_at    TEXT NOT NULL,
  due_at       TEXT NOT NULL,
  paid_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_issued ON invoices(issued_at);

CREATE TABLE IF NOT EXISTS invoice_line_items (
  id           INTEGER PRIMARY KEY,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id   INTEGER REFERENCES products(id),
  description  TEXT NOT NULL,
  quantity     INTEGER NOT NULL,
  unit_amount  INTEGER NOT NULL,
  amount       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_line_items_invoice ON invoice_line_items(invoice_id);

CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id),
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  amount       INTEGER NOT NULL,
  method       TEXT NOT NULL,       -- card | ach | wire
  reference    TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  recorded_by  INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);

-- rollup, maintained incrementally by triggers on invoices + payments
CREATE TABLE IF NOT EXISTS customer_balances (
  customer_id  INTEGER PRIMARY KEY REFERENCES customers(id),
  invoiced     INTEGER NOT NULL DEFAULT 0,
  paid         INTEGER NOT NULL DEFAULT 0,
  outstanding  INTEGER NOT NULL DEFAULT 0,
  overdue      INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

-- append-only ledger of MRR changes per customer (trigger on customers.mrr)
CREATE TABLE IF NOT EXISTS mrr_movements (
  id           INTEGER PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  at           TEXT NOT NULL,
  kind         TEXT NOT NULL,       -- new | expansion | contraction | churn | reactivation
  old_mrr      INTEGER NOT NULL,
  new_mrr      INTEGER NOT NULL,
  delta        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mrr_movements_customer ON mrr_movements(customer_id, at, id);
CREATE INDEX IF NOT EXISTS idx_mrr_movements_at ON mrr_movements(at);

-- while a row exists for a customer, mrr changes are not recorded one by one; deleting
-- the row records one net movement (mrr_before -> current mrr) at its "at" time
CREATE TABLE IF NOT EXISTS mrr_hold (
  customer_id  INTEGER PRIMARY KEY REFERENCES customers(id),
  mrr_before   INTEGER NOT NULL,
  at           TEXT NOT NULL
);

-- rollup, rebuilt from mrr_movements by a job (see rebuildMrrSnapshots)
CREATE TABLE IF NOT EXISTS mrr_snapshots (
  month              TEXT PRIMARY KEY,  -- YYYY-MM
  mrr                INTEGER NOT NULL,
  active_customers   INTEGER NOT NULL,
  new_customers      INTEGER NOT NULL,
  churned_customers  INTEGER NOT NULL,
  new_mrr            INTEGER NOT NULL,
  churned_mrr        INTEGER NOT NULL,
  computed_at        TEXT NOT NULL
);

-- ============================== delivery ==============================
CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  customer_id  INTEGER REFERENCES customers(id),
  owner_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  team_id      INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  status       TEXT NOT NULL,
  budget_hours INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL,
  priority     TEXT NOT NULL,
  assignee_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date     TEXT,
  position     REAL NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);

CREATE TABLE IF NOT EXISTS task_comments (
  id          INTEGER PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES tasks(id),  -- no cascade: comments are a permanent record
  author_id   INTEGER REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id);

CREATE TABLE IF NOT EXISTS time_entries (
  id          INTEGER PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  minutes     INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  spent_on    TEXT NOT NULL,
  billable    INTEGER NOT NULL DEFAULT 1,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_time_entries_task ON time_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_time_entries_user ON time_entries(user_id);

-- ============================== metering ==============================
CREATE TABLE IF NOT EXISTS usage_events (
  id           INTEGER PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  metric       TEXT NOT NULL,       -- api_calls | storage_gb | active_seats
  quantity     INTEGER NOT NULL,
  occurred_at  TEXT NOT NULL,
  idempotency_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_usage_events_customer ON usage_events(customer_id, occurred_at);

-- rollup, maintained incrementally by trigger on usage_events
CREATE TABLE IF NOT EXISTS usage_daily (
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  metric       TEXT NOT NULL,
  day          TEXT NOT NULL,
  quantity     INTEGER NOT NULL,
  events       INTEGER NOT NULL,
  PRIMARY KEY (customer_id, metric, day)
);

-- ============================== logs ==============================
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL,
  actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_id  INTEGER,
  message      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_customer ON events(customer_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  actor_id    INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,        -- create | update | delete | login | logout | denied
  entity      TEXT NOT NULL,
  entity_id   INTEGER,                     -- numeric keys (kept for compatibility)
  entity_key  TEXT,                        -- every key as text, incl. composite ones ("12:3")
  changes     TEXT NOT NULL DEFAULT '{}',  -- JSON {field: [before, after]}; deletes: [before, null]
  request_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity_key ON audit_log(entity, entity_key);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  entity      TEXT,
  entity_id   INTEGER,
  created_at  TEXT NOT NULL,
  read_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);

-- ============================== triggers: denormalisation & rollups ==============================
-- customers.mrr = Σ active subscriptions (trials contribute nothing until they convert)
CREATE TRIGGER IF NOT EXISTS trg_sub_mrr_ins AFTER INSERT ON subscriptions BEGIN
  UPDATE customers SET mrr = (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM subscriptions
    WHERE customer_id = NEW.customer_id AND status IN ('active', 'past_due')),
    mrr_changed_at = NEW.started_at
  WHERE id = NEW.customer_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_sub_mrr_upd AFTER UPDATE ON subscriptions BEGIN
  UPDATE customers SET mrr = (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM subscriptions
    WHERE customer_id = NEW.customer_id AND status IN ('active', 'past_due')),
    mrr_changed_at = CASE WHEN NEW.canceled_at IS NOT NULL AND OLD.canceled_at IS NULL THEN NEW.canceled_at
                          ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
  WHERE id = NEW.customer_id;
END;

-- MRR movements ledger: one row per change of customers.mrr (unless held, see mrr_hold)
CREATE TRIGGER IF NOT EXISTS trg_mrr_movement AFTER UPDATE OF mrr ON customers
WHEN NEW.mrr != OLD.mrr AND NOT EXISTS (SELECT 1 FROM mrr_hold WHERE customer_id = NEW.id)
BEGIN
  INSERT INTO mrr_movements (customer_id, at, kind, old_mrr, new_mrr, delta)
  VALUES (NEW.id, COALESCE(NEW.mrr_changed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CASE WHEN NEW.mrr > 0 AND OLD.mrr = 0
         THEN CASE WHEN EXISTS (SELECT 1 FROM mrr_movements WHERE customer_id = NEW.id) THEN 'reactivation' ELSE 'new' END
       WHEN NEW.mrr = 0 THEN 'churn' WHEN NEW.mrr > OLD.mrr THEN 'expansion' ELSE 'contraction' END,
    OLD.mrr, NEW.mrr, NEW.mrr - OLD.mrr);
END;
CREATE TRIGGER IF NOT EXISTS trg_mrr_hold_release AFTER DELETE ON mrr_hold
WHEN (SELECT mrr FROM customers WHERE id = OLD.customer_id) != OLD.mrr_before
BEGIN
  INSERT INTO mrr_movements (customer_id, at, kind, old_mrr, new_mrr, delta)
  SELECT c.id, OLD.at, CASE WHEN c.mrr > 0 AND OLD.mrr_before = 0
         THEN CASE WHEN EXISTS (SELECT 1 FROM mrr_movements WHERE customer_id = c.id) THEN 'reactivation' ELSE 'new' END
       WHEN c.mrr = 0 THEN 'churn' WHEN c.mrr > OLD.mrr_before THEN 'expansion' ELSE 'contraction' END,
    OLD.mrr_before, c.mrr, c.mrr - OLD.mrr_before
  FROM customers c WHERE c.id = OLD.customer_id;
END;

-- invoices.amount = Σ line items
CREATE TRIGGER IF NOT EXISTS trg_line_item_ins AFTER INSERT ON invoice_line_items BEGIN
  UPDATE invoices SET amount = (SELECT COALESCE(SUM(amount), 0) FROM invoice_line_items WHERE invoice_id = NEW.invoice_id)
  WHERE id = NEW.invoice_id;
END;

-- a payment that covers the invoice marks it paid
CREATE TRIGGER IF NOT EXISTS trg_payment_settles AFTER INSERT ON payments BEGIN
  UPDATE invoices SET status = 'paid', paid_at = NEW.received_at
  WHERE id = NEW.invoice_id AND status != 'paid'
    AND (SELECT SUM(amount) FROM payments WHERE invoice_id = NEW.invoice_id) >= amount;
END;

-- customer_balances rollup
CREATE TRIGGER IF NOT EXISTS trg_balance_inv_ins AFTER INSERT ON invoices BEGIN
  INSERT INTO customer_balances (customer_id, updated_at) VALUES (NEW.customer_id, NEW.issued_at)
  ON CONFLICT(customer_id) DO NOTHING;
END;
-- outstanding / overdue = what is still owed on open / overdue invoices (amount minus payments on them),
-- the same definition /metrics/ar-aging uses
CREATE TRIGGER IF NOT EXISTS trg_balance_inv_upd AFTER UPDATE OF amount, status ON invoices BEGIN
  UPDATE customer_balances SET
    invoiced = (SELECT COALESCE(SUM(amount), 0) FROM invoices WHERE customer_id = NEW.customer_id AND status != 'void'),
    outstanding = (SELECT COALESCE(SUM(i.amount - (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.invoice_id = i.id)), 0)
                   FROM invoices i WHERE i.customer_id = NEW.customer_id AND i.status IN ('open', 'overdue')),
    overdue = (SELECT COALESCE(SUM(i.amount - (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.invoice_id = i.id)), 0)
               FROM invoices i WHERE i.customer_id = NEW.customer_id AND i.status = 'overdue'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE customer_id = NEW.customer_id;
END;
CREATE TRIGGER IF NOT EXISTS trg_balance_pay AFTER INSERT ON payments BEGIN
  UPDATE customer_balances SET
    paid = (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE customer_id = NEW.customer_id),
    outstanding = (SELECT COALESCE(SUM(i.amount - (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.invoice_id = i.id)), 0)
                   FROM invoices i WHERE i.customer_id = NEW.customer_id AND i.status IN ('open', 'overdue')),
    overdue = (SELECT COALESCE(SUM(i.amount - (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.invoice_id = i.id)), 0)
               FROM invoices i WHERE i.customer_id = NEW.customer_id AND i.status = 'overdue'),
    updated_at = NEW.received_at
  WHERE customer_id = NEW.customer_id;
END;

-- usage_daily rollup
CREATE TRIGGER IF NOT EXISTS trg_usage_rollup AFTER INSERT ON usage_events BEGIN
  INSERT INTO usage_daily (customer_id, metric, day, quantity, events)
  VALUES (NEW.customer_id, NEW.metric, substr(NEW.occurred_at, 1, 10), NEW.quantity, 1)
  ON CONFLICT(customer_id, metric, day) DO UPDATE SET quantity = quantity + excluded.quantity, events = events + 1;
END;

-- ============================== triggers: append-only tables ==============================
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_no_update BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT, 'payments is an append-only ledger'); END;
CREATE TRIGGER IF NOT EXISTS trg_payments_no_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT, 'payments is an append-only ledger'); END;
CREATE TRIGGER IF NOT EXISTS trg_comments_no_update BEFORE UPDATE ON task_comments BEGIN SELECT RAISE(ABORT, 'task_comments is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_comments_no_delete BEFORE DELETE ON task_comments BEGIN SELECT RAISE(ABORT, 'task_comments is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_usage_no_update BEFORE UPDATE ON usage_events BEGIN SELECT RAISE(ABORT, 'usage_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_usage_no_delete BEFORE DELETE ON usage_events BEGIN SELECT RAISE(ABORT, 'usage_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_mrr_movements_no_update BEFORE UPDATE ON mrr_movements BEGIN SELECT RAISE(ABORT, 'mrr_movements is an append-only ledger'); END;
CREATE TRIGGER IF NOT EXISTS trg_mrr_movements_no_delete BEFORE DELETE ON mrr_movements BEGIN SELECT RAISE(ABORT, 'mrr_movements is an append-only ledger'); END;

-- ============================== views ==============================
CREATE VIEW IF NOT EXISTS project_stats AS
SELECT p.id AS project_id,
       COUNT(DISTINCT t.id) AS task_count,
       COUNT(DISTINCT CASE WHEN t.status = 'done' THEN t.id END) AS done_count,
       COALESCE((SELECT SUM(te.minutes) FROM time_entries te JOIN tasks t2 ON t2.id = te.task_id WHERE t2.project_id = p.id), 0) AS minutes_logged,
       COALESCE((SELECT SUM(te.minutes) FROM time_entries te JOIN tasks t2 ON t2.id = te.task_id WHERE t2.project_id = p.id AND te.billable = 1), 0) AS billable_minutes
FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
GROUP BY p.id;

CREATE VIEW IF NOT EXISTS customer_health AS
SELECT c.id AS customer_id,
       c.mrr,
       COALESCE(b.overdue, 0) AS overdue,
       COALESCE((SELECT SUM(quantity) FROM usage_daily u WHERE u.customer_id = c.id AND u.metric = 'api_calls'
                 AND u.day >= date('now', '-30 days')), 0) AS api_calls_30d,
       CASE
         WHEN c.status = 'churned' THEN 'churned'
         WHEN COALESCE(b.overdue, 0) > 0 THEN 'at_risk'
         WHEN COALESCE((SELECT SUM(quantity) FROM usage_daily u WHERE u.customer_id = c.id AND u.metric = 'api_calls'
                        AND u.day >= date('now', '-14 days')), 0) = 0 THEN 'dormant'
         ELSE 'healthy'
       END AS health
FROM customers c LEFT JOIN customer_balances b ON b.customer_id = c.id
WHERE c.deleted_at IS NULL;
`

export function openDatabase(file: string): DB {
  // a fresh checkout (e.g. CI) has no ./data directory yet; SQLite won't create it
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}

export const TABLES = [
  'roles',
  'permissions',
  'role_permissions',
  'users',
  'sessions',
  'teams',
  'team_members',
  'customers',
  'contacts',
  'tags',
  'customer_tags',
  'products',
  'subscriptions',
  'invoices',
  'invoice_line_items',
  'payments',
  'customer_balances',
  'mrr_movements',
  'mrr_hold',
  'mrr_snapshots',
  'projects',
  'tasks',
  'task_comments',
  'time_entries',
  'usage_events',
  'usage_daily',
  'events',
  'audit_log',
  'notifications',
] as const
