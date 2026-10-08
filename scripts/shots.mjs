// Dev helper: visit pages, collect console errors + API requests, save screenshots.
//   node scripts/shots.mjs <outDir> [comma,separated,paths]
import { chromium } from '@playwright/test'
const base = process.env.BASE ?? 'http://localhost:5173'
const out = process.argv[2] ?? 'shots'
const pages = (
  process.argv[3] ?? '/,/analytics,/customers,/customers/1,/invoices,/projects,/projects/1,/team,/activity,/settings'
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
for (const p of pages) {
  requests.push(`--- navigate ${p}`)
  await page.goto(base + p, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${out}/${p === '/' ? 'home' : p.slice(1).replaceAll('/', '-')}.png`, fullPage: true })
}
console.log(errors.length ? errors.join('\n') : 'NO ERRORS')
console.log(requests.join('\n'))
await browser.close()
