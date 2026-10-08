// Dev helper: sign in, visit pages, collect console errors + API requests, save screenshots.
//   ROLE=owner node scripts/shots.mjs <outDir> [comma,separated,paths]
import { chromium } from '@playwright/test'
const base = process.env.BASE ?? 'http://localhost:5173'
const role = process.env.ROLE ?? 'owner'
const out = process.argv[2] ?? 'shots'
const pages = (
  process.argv[3] ??
  '/,/analytics,/customers,/customers/1,/invoices,/billing,/products,/projects,/projects/1,/team,/activity,/audit,/settings'
).split(',')
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
const requests = []
page.on(
  'console',
  (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`[${m.type()} ${page.url()}] ${m.text().slice(0, 300)}`),
)
page.on('pageerror', (e) => errors.push(`[${page.url()}] PAGEERROR ${e.message}`))
page.on(
  'request',
  (r) =>
    r.url().includes('/api/') && requests.push(`${r.method()} ${decodeURIComponent(r.url().replace(/^https?:\/\/[^/]+/, ''))}`),
)
const login = await page.request.post(`${base}/api/auth/login`, { data: { email: `${role}@saasly.dev`, password: 'password' } })
if (!login.ok()) throw new Error(`login failed ${login.status()}`)
for (const p of pages) {
  requests.push(`--- navigate ${p}`)
  await page.goto(base + p, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${out}/${role}-${p === '/' ? 'home' : p.slice(1).replaceAll('/', '-')}.png`, fullPage: true })
}
console.log(errors.length ? errors.join('\n') : 'NO ERRORS')
if (process.env.REQS) console.log(requests.join('\n'))
await browser.close()
