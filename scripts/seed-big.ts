// Bulk-generate a large demo database (millions of rows) to see how both data
// layers behave when the data no longer fits in the browser.
//
//   pnpm db:big                       # data/big.db, 250k customers (~12M rows, ~2 GB, ~5 min)
//   pnpm db:big --customers 50000     # smaller
//   DB_FILE=data/big.db pnpm dev      # run the app against it
//
// The data goes through the same seed (and the same triggers) as the small
// demo database, so every rollup, ledger and history table stays consistent.
// Note: Settings → "Reset database" (/api/dev/reset) re-seeds the SMALL dataset.
import { existsSync, rmSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { openDatabase } from '../server/db/schema.ts'
import { seed } from '../server/db/seed.ts'
import { SCHEMA_VERSION } from '../server/services.ts'

const { values } = parseArgs({
  options: {
    file: { type: 'string', default: 'data/big.db' },
    customers: { type: 'string', default: '250000' },
    events: { type: 'string', default: '1500000' },
    audit: { type: 'string', default: '1000000' },
    'usage-days': { type: 'string', default: '12' },
  },
})
const file = values.file!
const n = (k: keyof typeof values) => Number(String(values[k]).replaceAll('_', ''))

for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) rmSync(f)
const db = openDatabase(file)
// a throwaway bulk load: no durability needed until the end
db.pragma('synchronous = OFF')
db.pragma('cache_size = -262144') // 256 MB
db.pragma('temp_store = MEMORY')

const started = performance.now()
const elapsed = () => `${((performance.now() - started) / 1000).toFixed(0)}s`
seed(db, {
  customers: n('customers'),
  events: n('events'),
  audit: n('audit'),
  usageDays: n('usage-days'),
  users: 60,
  projects: 120,
  log: (m) => console.log(`[${elapsed()}] ${m}`),
})
db.pragma(`user_version = ${SCHEMA_VERSION}`)
console.log(`[${elapsed()}] ANALYZE (query planner statistics)`)
db.exec('ANALYZE')
db.pragma('synchronous = NORMAL')
db.pragma('wal_checkpoint(TRUNCATE)')

const tables = (
  db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name`,
    )
    .all() as Array<{ name: string }>
).map((t) => t.name)
const counts = tables
  .map((t) => ({ table: t, rows: (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n }))
  .sort((a, b) => b.rows - a.rows)
console.table(counts.filter((c) => c.rows > 0).map((c) => ({ table: c.table, rows: c.rows.toLocaleString() })))
console.log(`total rows: ${counts.reduce((s, c) => s + c.rows, 0).toLocaleString()} — ${file} in ${elapsed()}`)
db.close()
