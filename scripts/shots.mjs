// Dev helper: visit every page, collect console errors, save screenshots.
import { chromium } from '@playwright/test'
const base = process.env.BASE ?? 'http://localhost:5173'
const out = process.argv[2] ?? 'shots'
const pages = [
  '/',
  '/analytics',
  '/customers',
  '/customers/1',
  '/invoices',
  '/projects',
  '/projects/1',
  '/team',
  '/activity',
  '/settings',
]
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(`[${page.url()}] ${m.text()}`))
page.on('pageerror', (e) => errors.push(`[${page.url()}] PAGEERROR ${e.message}`))
for (const p of pages) {
  await page.goto(base + p, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${out}/${p === '/' ? 'home' : p.slice(1).replaceAll('/', '-')}.png`, fullPage: true })
}
console.log(errors.length ? errors.join('\n') : 'NO ERRORS')
await browser.close()
