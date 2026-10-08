import Database from 'better-sqlite3'

export type DB = Database.Database

export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL,
  title         TEXT NOT NULL,
  avatar_color  TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  company     TEXT NOT NULL,
  plan        TEXT NOT NULL,
  status      TEXT NOT NULL,
  country     TEXT NOT NULL,
  seats       INTEGER NOT NULL,
  mrr         INTEGER NOT NULL,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_plan ON customers(plan);
CREATE INDEX IF NOT EXISTS idx_customers_created ON customers(created_at);

CREATE TABLE IF NOT EXISTS invoices (
  id           INTEGER PRIMARY KEY,
  number       TEXT NOT NULL UNIQUE,
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount       INTEGER NOT NULL,
  status       TEXT NOT NULL,
  issued_at    TEXT NOT NULL,
  due_at       TEXT NOT NULL,
  paid_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_issued ON invoices(issued_at);

CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  owner_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status       TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL,
  actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  customer_id  INTEGER,
  message      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
`

export function openDatabase(file: string): DB {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
