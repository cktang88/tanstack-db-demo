// Scripted user journey used for the Query-vs-DB comparison in the PR.
//   BASE=http://localhost:5173 node scripts/journey.mjs
import { chromium } from '@playwright/test'
const base = process.env.BASE ?? 'http://localhost:5173'
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
// the session cookie set here is shared with the page
const login = await page.request.post(`${base}/api/auth/login`, { data: { email: 'owner@saasly.dev', password: 'password' } })
if (!login.ok()) throw new Error(`login failed: ${login.status()}`)
await page.request.post(`${base}/api/dev/reset`, { data: {} })
await page.request.put(`${base}/api/dev/chaos`, { data: { latencyMs: 150, failRate: 0 } })

let reqs = []
let bytes = 0
const isApi = (url) => {
  const u = new URL(url)
  return u.pathname.startsWith('/api/') && !u.pathname.endsWith('/stream')
}
page.on('request', (r) => {
  if (isApi(r.url())) reqs.push(`${r.method()} ${new URL(r.url()).pathname}`)
})
// response body bytes of API calls (what the data layer actually downloads)
page.on('requestfinished', async (r) => {
  if (!isApi(r.url())) return
  const sizes = await r.sizes().catch(() => null)
  if (sizes) bytes += sizes.responseBodySize
})
const results = []
async function step(name, fn) {
  reqs = []
  bytes = 0
  const t = performance.now()
  await fn()
  const ms = Math.round(performance.now() - t)
  await page.waitForTimeout(600) // let trailing background refetches show up
  results.push({
    step: name,
    'ui ready (ms)': ms,
    requests: reqs.length,
    kB: Math.round(bytes / 1024),
    detail: [...new Set(reqs)].join(' '),
  })
}
const nav = (label) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label }).click()
const table = page.getByTestId('customers-table')

await step('cold load /', async () => {
  await page.goto(base + '/')
  await page.getByTestId('kpi-mrr').getByText(/^\$/).waitFor()
  await page.getByTestId('top-customers').locator('li').first().waitFor()
})
await step('open Customers', async () => {
  await nav('Customers')
  await table.getByTestId('row').nth(24).waitFor()
})
await step('filter status=Active', async () => {
  await page.getByRole('button', { name: 'Active', pressed: false }).click()
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid=row]')].every((r) => r.textContent.includes('Active')),
  )
})
await step('search "Labs"', async () => {
  await page.getByLabel('Search customers').fill('Labs')
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('[data-testid=customers-table] [data-testid=row]')]
    return rows.length > 0 && rows.every((r) => r.textContent.includes('Labs'))
  })
})
await step('next page', async () => {
  const before = await table.getByTestId('page-info').textContent()
  await page.getByLabel('Next page').click()
  await page.waitForFunction((b) => document.querySelector('[data-testid=page-info]').textContent !== b, before)
  await page.waitForFunction(() => !document.querySelector('table.opacity-60'))
})
await step('sort by MRR', async () => {
  await page.getByRole('button', { name: /^mrr/i }).click()
  await page.waitForFunction(() => document.querySelector('th[aria-sort]') && !document.querySelector('table.opacity-60'))
})
await step('open customer detail', async () => {
  await table.getByTestId('row').first().getByRole('link').first().click()
  await page.getByTestId('customer-mrr').waitFor()
  await page.getByTestId('customer-invoices').or(page.getByText('No invoices yet.')).waitFor()
})
await step('edit seats (+5) -> MRR shown', async () => {
  const before = await page.getByTestId('customer-mrr').textContent()
  await page.getByRole('button', { name: 'Edit' }).click()
  const seats = page.getByRole('dialog').getByLabel('Seats')
  await seats.fill(String(Number(await seats.inputValue()) + 5))
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click()
  await page.waitForFunction((b) => document.querySelector('[data-testid=customer-mrr]').textContent !== b, before)
})
await step('back to Overview (KPIs reflect edit)', async () => {
  await nav('Overview')
  await page.getByTestId('kpi-mrr').getByText(/^\$/).waitFor()
  await page.getByTestId('top-customers').locator('li').first().waitFor()
})
await step('Invoices: filter Overdue', async () => {
  await nav('Invoices')
  await page.getByRole('button', { name: 'Overdue', pressed: false }).click()
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('[data-testid=invoices-table] [data-testid=row]')]
    return rows.length > 0 && rows.every((r) => r.textContent.includes('Overdue') && !r.textContent.includes('Paid'))
  })
})
await step('mark first invoice paid', async () => {
  const n = await page.getByTestId('invoices-table').getByTestId('row').first().locator('td').first().textContent()
  await page.getByTestId('invoices-table').getByTestId('row').first().getByRole('button', { name: 'Mark paid' }).click()
  await page.waitForFunction(
    (n) =>
      ![...document.querySelectorAll('[data-testid=row]')].some(
        (r) => r.textContent.includes(n) && r.textContent.includes('Overdue'),
      ),
    n,
  )
})
await step('customer: expand invoice (line items + ledger)', async () => {
  await page.getByTestId('invoices-table').getByTestId('row').first().getByRole('link').click()
  await page.getByTestId('customer-invoices').waitFor()
  await page.getByTestId('customer-invoices').getByRole('row').nth(1).click()
  await page.getByTestId('invoice-payments').waitFor()
})
await step('toggle a tag (many-to-many)', async () => {
  const tag = page.getByTestId('tags').getByRole('button').first()
  const before = await tag.getAttribute('aria-pressed')
  await tag.click()
  await page.waitForFunction(
    (b) => document.querySelector('[data-testid=tags] button').getAttribute('aria-pressed') !== b,
    before,
  )
})
await step('Billing (MRR rollup, AR aging, ledger)', async () => {
  await nav('Billing')
  await page.getByTestId('billing-mrr').getByText(/\$/).first().waitFor()
  await page.getByTestId('payments-table').getByTestId('row').first().waitFor()
})
await step('Projects -> board', async () => {
  await nav('Projects')
  await page.getByTestId('project-card').first().click()
  await page.getByTestId('task-card').first().waitFor()
})
await step('move a task right', async () => {
  const col = page.getByTestId('column-in_progress').getByTestId('column-count')
  const before = await col.textContent()
  await page.getByTestId('column-todo').getByTestId('task-card').first().getByLabel('Move right').click()
  await page.waitForFunction(
    (b) => document.querySelector('[data-testid=column-in_progress] [data-testid=column-count]').textContent !== b,
    before,
  )
})
await step('Team page', async () => {
  await nav('Team')
  await page.getByTestId('member-row').first().waitFor()
})
await step('Teams tab: add a member', async () => {
  await page.getByRole('radio', { name: 'Teams' }).click()
  const team = page.getByTestId('teams').locator('section').first()
  const before = await team.getByRole('listitem').count()
  await team.getByRole('combobox').selectOption({ index: 1 })
  await page.waitForFunction(
    (b) => document.querySelector('[data-testid=teams] section').querySelectorAll('li').length !== b,
    before,
  )
})
console.table(results.map(({ detail: _detail, ...r }) => r))
console.log(JSON.stringify(results))
const total = results.reduce((s, r) => s + r.requests, 0)
console.log(
  'TOTAL requests:',
  total,
  ' TOTAL ui ms:',
  results.reduce((s, r) => s + r['ui ready (ms)'], 0),
  ' TOTAL kB:',
  results.reduce((s, r) => s + r.kB, 0),
)
await browser.close()
