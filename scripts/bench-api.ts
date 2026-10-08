// Time the API requests both clients make against a (big) database, in-process
// (no network, no artificial latency): what the SQL behind each endpoint costs.
//
//   pnpm db:big && pnpm bench:api                    # data/big.db
//   pnpm bench:api --file data/dev.db --runs 9
import { parseArgs } from 'node:util'
import { makeApp } from '../server/app.ts'

const { values } = parseArgs({
  options: {
    file: { type: 'string', default: 'data/big.db' },
    runs: { type: 'string', default: '5' },
    json: { type: 'boolean', default: false },
  },
})

// a mid-sized customer that exists in every seed size
const C = 1234

const SCENARIOS: Array<[group: string, label: string, path: string]> = [
  ['customers', 'first page (newest)', '/customers?page=1&pageSize=25&sort=-createdAt&sum=mrr'],
  ['customers', 'status+plan filter, sort by MRR', '/customers?status=active&plan=pro&sort=-mrr&page=1&pageSize=25&sum=mrr'],
  ['customers', 'search "labs"', '/customers?q=labs&page=1&pageSize=25&sum=mrr'],
  ['customers', 'search "zz" (no match)', '/customers?q=zz&page=1&pageSize=25&sum=mrr'],
  ['customers', 'sort by owner name', '/customers?sort=owner&page=1&pageSize=25'],
  ['customers', 'country filter, sort by company', '/customers?country=DE&sort=company&page=1&pageSize=25&sum=mrr'],
  ['customers', 'deep page (offset 100k)', '/customers?page=4001&pageSize=25&sort=-createdAt'],
  ['customers', 'count only', '/customers?limit=0'],
  ['customers', 'eager load (limit 10000)', '/customers?limit=10000'],
  ['invoices', 'first page', '/invoices?page=1&pageSize=25&sort=-issuedAt&sum=amount'],
  ['invoices', 'status=overdue', '/invoices?status=overdue&page=1&pageSize=25&sort=-issuedAt&sum=amount'],
  ['invoices', 'search company "labs"', '/invoices?q=labs&page=1&pageSize=25&sum=amount'],
  ['invoices', 'sort by customer company', '/invoices?sort=customer&page=1&pageSize=25'],
  ['invoices', 'one customer', `/invoices?customerId=${C}&sort=-issuedAt&limit=100`],
  ['invoices', 'eager load (limit 10000)', '/invoices?limit=10000'],
  ['ledger', 'payments, newest 10', '/payments?sort=-receivedAt&limit=10'],
  ['ledger', 'payments of one invoice', '/payments?invoiceId[eq]=5000'],
  ['activity', 'feed, first page', '/events/feed?limit=50'],
  ['activity', 'feed, invoice category', '/events/feed?limit=50&type=invoice.'],
  ['activity', 'one customer, newest 20', `/events?customerId[eq]=${C}&sort=-id&limit=20`],
  ['usage', 'one customer daily api_calls', `/usage-daily?customerId[eq]=${C}&metric[eq]=api_calls&sort=day`],
  ['usage', 'one customer health (view)', `/customer-health/${C}`],
  ['audit', 'first page', '/audit-log?page=1&pageSize=50'],
  ['audit', 'filter entity=customers', '/audit-log?entity=customers&page=1&pageSize=50'],
  ['metrics', 'overview', '/metrics/overview'],
  ['metrics', 'revenue, 12 months', '/metrics/revenue?months=12'],
  ['metrics', 'signups, 12 months', '/metrics/signups?months=12'],
  ['metrics', 'breakdown by country', '/metrics/breakdown?by=country'],
  ['metrics', 'breakdown by status, plan=pro', '/metrics/breakdown?by=status&plan=pro'],
  ['metrics', 'AR aging', '/metrics/ar-aging'],
  ['metrics', 'workload', '/metrics/workload'],
  ['billing', 'MRR snapshots', '/mrr-snapshots'],
  ['detail', 'customer', `/customers/${C}`],
  ['detail', 'balance', `/customer-balances/${C}`],
]

const { app } = makeApp({ db: { file: values.file! }, chaos: { latencyMs: 0, failRate: 0 } })
const login = await app.request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'owner@saasly.dev', password: 'password' }),
})
if (!login.ok) throw new Error(`login failed: ${login.status}`)
const { token } = (await login.json()) as { token: string }

const runs = Number(values.runs)
const results = []
for (const [group, label, path] of SCENARIOS) {
  const times: number[] = []
  let status = 0
  let bytes = 0
  let rows: number | string = ''
  for (let i = 0; i < runs; i++) {
    const t = performance.now()
    const res = await app.request(`/api${path}`, { headers: { authorization: `Bearer ${token}` } })
    const text = await res.text()
    times.push(performance.now() - t)
    status = res.status
    bytes = text.length
    const body = JSON.parse(text)
    rows = Array.isArray(body)
      ? body.length
      : Array.isArray(body?.data)
        ? `${body.data.length}${body.total !== undefined ? ` of ${body.total}` : ''}`
        : 1
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)]!
  results.push({
    group,
    request: label,
    'median ms': Math.round(median * 10) / 10,
    rows,
    kB: Math.round(bytes / 1024),
    status,
    path,
  })
}
if (values.json) console.log(JSON.stringify(results))
else console.table(results.map(({ path: _path, ...r }) => r))
process.exit(0)
