import { expect, test, type Page } from '@playwright/test'
import { resetDemo } from './helpers'

// User-visible features that exist on every branch, whatever the data layer
// (TanStack Query on main, TanStack DB on the port). Only the UI and the
// public API are observed here — never which requests were made.

const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const usd = (n: number) => usdFmt.format(n)
const dollars = (text: string) => Number(text.replace(/[^0-9.-]/g, ''))

const setChaos = (page: Page, chaos: { latencyMs: number; failRate: number }) =>
  page.request.put('/api/dev/chaos', { data: chaos })

const getJson = async <T>(page: Page, path: string) => {
  const res = await page.request.get(path)
  expect(res.ok()).toBe(true)
  return (await res.json()) as T
}

test.beforeAll(({ playwright, baseURL }) => resetDemo(playwright, baseURL))

test.afterEach(async ({ page }) => {
  await setChaos(page, { latencyMs: 120, failRate: 0 })
})

test.describe('preferences', () => {
  test('theme and pins sync across tabs', async ({ page, context }) => {
    await page.goto('/settings')
    const other = await context.newPage()
    await other.goto('/')
    await page.getByRole('radio', { name: 'Dark' }).click()
    await expect(other.locator('html')).toHaveClass(/dark/)

    await page.goto('/customers/1')
    await page.getByRole('button', { name: '☆ Pin' }).click()
    await expect(other.getByTestId('pinned-accounts').getByRole('link')).toHaveCount(1)
    await page.getByRole('button', { name: '★ Pinned' }).click()
    await expect(other.getByTestId('pinned-accounts')).toHaveCount(0)
    await page.goto('/settings')
    await page.getByRole('radio', { name: 'Light' }).click()
    await expect(other.locator('html')).not.toHaveClass(/dark/)
    await other.close()
  })

  test('a pinned customer shows up on the overview', async ({ page }) => {
    await page.goto('/customers/2')
    const company = (await page.getByRole('heading', { level: 1 }).textContent())!
    await page.getByRole('button', { name: '☆ Pin' }).click()
    await expect(page.getByRole('button', { name: '★ Pinned' })).toBeVisible()
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Overview' }).click()
    await expect(page.getByText('Pinned accounts (1)')).toBeVisible()
    await expect(page.getByTestId('pinned-accounts').getByRole('link')).toHaveText(company)
    await expect(page.getByTestId('pinned-accounts')).toContainText('MRR')
    // unpin again so other tests start without pins
    await page.getByTestId('pinned-accounts').getByRole('link').click()
    await page.getByRole('button', { name: '★ Pinned' }).click()
    await expect(page.getByRole('button', { name: '☆ Pin' })).toBeVisible()
  })
})

test.describe('customers', () => {
  test('row selection survives paging and is summarised', async ({ page }) => {
    await page.goto('/customers?status=active')
    const table = page.getByTestId('customers-table')
    await table.getByLabel('Select row').nth(0).check()
    await page.getByLabel('Next page').click()
    await table.getByLabel('Select row').nth(0).check()
    await expect(table.getByTestId('selection-summary')).toContainText('2 across all pages')
    await page.getByLabel('Previous page').click()
    await expect(table.getByLabel('Select row').nth(0)).toBeChecked()
    await table.getByRole('button', { name: 'Clear' }).click()
    await expect(table.getByTestId('bulk-bar')).toHaveCount(0)
  })

  test('the header sums the matching rows and follows the filters', async ({ page }) => {
    await page.goto('/customers')
    const summary = page.getByText(/[\d,]+ matching · \$[\d,]+ MRR/)
    await expect(summary).toBeVisible()
    const all = (await summary.textContent())!.match(/[\d,]+ matching · \$[\d,]+ MRR/)![0]
    await page.getByRole('button', { name: 'Pro', pressed: false }).click()
    await expect(summary).not.toContainText(all)
    await expect(summary).toContainText(/[\d,]+ matching · \$[\d,]+ MRR/)
  })

  test('a change made by another client shows up in the table without a reload', async ({ page }) => {
    await page.goto('/customers?q=Tyrell')
    const row = page.getByTestId('customers-table').getByTestId('row').first()
    const href = (await row.getByRole('link').first().getAttribute('href'))!
    const id = Number(href.split('/').pop())
    const current = await getJson<{ seats: number }>(page, `/api/customers/${id}`)
    const nextSeats = current.seats + 7
    expect((await page.request.patch(`/api/customers/${id}`, { data: { seats: nextSeats } })).ok()).toBe(true)
    await expect(row.locator('td').nth(6)).toHaveText(String(nextSeats))
  })

  test('the seats slider shows and saves the new seat count', async ({ page }) => {
    await page.goto('/customers/1')
    const value = page.getByTestId('seats-value')
    await expect(value).toHaveText(/^\d+ seats$/)
    const before = Number((await value.textContent())!.split(' ')[0])
    const slider = page.getByLabel('Seats', { exact: true })
    await slider.focus()
    await slider.press('ArrowRight')
    await expect(value).toHaveText(`${before + 1} seats`)
    await expect.poll(async () => (await getJson<{ seats: number }>(page, '/api/customers/1')).seats).toBe(before + 1)
  })
})

test.describe('invoices & billing', () => {
  test('the invoice total follows the status filter', async ({ page }) => {
    await page.goto('/invoices')
    const total = page.getByTestId('invoice-total')
    await expect(total).toContainText('$')
    const all = await total.textContent()
    await page.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Paid' }).click()
    await expect(total).not.toHaveText(all!)
    await expect(total).toContainText('$')
  })

  test('a partial payment moves the balance by exactly the amount paid', async ({ page }) => {
    await page.goto('/invoices?status=open')
    await page.getByTestId('invoices-table').getByTestId('row').first().getByRole('link').click()
    const balance = page.getByTestId('balance-value')
    await expect(balance).toBeVisible()
    await page
      .getByTestId('customer-invoices')
      .getByRole('row')
      .filter({ hasText: /open|overdue/i })
      .first()
      .click()
    const detail = page.getByTestId('invoice-detail')
    await expect(detail.getByTestId('invoice-payments')).toBeVisible()
    const customerId = Number(new URL(page.url()).pathname.split('/').pop())
    const rollup = async () =>
      (await getJson<{ outstanding: number }>(page, `/api/customer-balances/${customerId}`)).outstanding / 100
    await expect(balance).toHaveText(usd(await rollup()))
    const before = dollars((await balance.textContent())!)
    await detail.getByLabel('Payment amount').fill('1')
    await detail.getByRole('button', { name: 'Record payment' }).click()
    await expect(detail.getByTestId('invoice-payments').getByText('$1', { exact: true })).toBeVisible()
    await expect(balance).toHaveText(usd(before - 1))
    // the client's balance agrees with the server's trigger-maintained rollup
    await expect.poll(async () => usd(await rollup())).toBe(usd(before - 1))
  })
})

test.describe('analytics, overview, projects, sidebar', () => {
  test('the analytics plan filter re-slices the breakdowns', async ({ page }) => {
    await page.goto('/analytics')
    const charts = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'MRR by country' }) })
      .locator('..')
    const text = () => charts.evaluate((el) => el.textContent ?? '')
    await expect.poll(text).toMatch(/\$/)
    const all = await text()
    await page.getByLabel('Plan filter').selectOption('free')
    await expect.poll(text).not.toBe(all)
  })

  test('project cards list the next open tasks', async ({ page }) => {
    await page.goto('/projects')
    await expect(page.getByTestId('project-card').first()).toBeVisible()
    await expect(page.getByTestId('project-grid').getByText(/^→ /).first()).toBeVisible()
  })

  test('the sidebar shows row counts', async ({ page }) => {
    await page.goto('/')
    const stats = page.getByTestId('db-stats')
    await expect(stats).toContainText('customers')
    await expect(stats).toContainText('tasks')
    await expect(stats.locator('dd').first()).toHaveText(/^\d[\d,]*$/)
  })
})

test.describe('projects & tasks', () => {
  test('a moved card shows that it is saving until the server confirms', async ({ page }) => {
    await page.goto('/projects/4')
    const card = page.getByTestId('column-todo').getByTestId('task-card').first()
    const title = (await card.getByTestId('task-title').textContent())!
    await setChaos(page, { latencyMs: 1500, failRate: 0 })
    await card.getByLabel('Move right').click()
    const moved = page.getByTestId('column-in_progress').getByTestId('task-card').filter({ hasText: title })
    await expect(moved).toHaveAttribute('data-pending', 'true')
    await expect(moved).toContainText('saving…')
    await expect(moved).not.toHaveAttribute('data-pending', 'true', { timeout: 10_000 })
  })

  test('the project description autosaves and survives a reload', async ({ page }) => {
    await page.goto('/projects/5')
    const box = page.getByLabel('Project description')
    const label = page.locator('label').filter({ has: box })
    await box.fill('')
    await box.pressSequentially('Rolled out to every region', { delay: 20 })
    await expect(label).toContainText('saving…')
    await expect(label).not.toContainText('saving…', { timeout: 10_000 })
    await expect
      .poll(async () => (await getJson<{ description: string }>(page, '/api/projects/5')).description)
      .toBe('Rolled out to every region')
    await page.reload()
    await expect(page.getByLabel('Project description')).toHaveValue('Rolled out to every region')
  })

  test('a server-side refusal (409: task has comments) restores the deleted card', async ({ page }) => {
    await page.goto('/projects/1')
    const card = page.getByTestId('task-card').first()
    const title = (await card.getByTestId('task-title').textContent())!
    await card.getByTestId('task-title').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Comment').fill('Blocking the delete')
    await dialog.getByRole('button', { name: 'Post' }).click()
    await expect(dialog.getByText('Blocking the delete')).toBeVisible()
    await expect(dialog.getByTestId('comments')).not.toContainText('sending…')
    await page.keyboard.press('Escape')
    await page.getByTestId('task-card').filter({ hasText: title }).first().hover()
    await page
      .getByRole('button', { name: `Delete ${title}` })
      .first()
      .click()
    await expect(page.getByRole('alert').filter({ hasText: 'Could not delete task' })).toBeVisible()
    await expect(page.getByTestId('task-card').filter({ hasText: title }).first()).toBeVisible()
  })
})

test.describe('team', () => {
  test('a staged rebalance previews locally, discards, then saves and persists', async ({ page }) => {
    await page.goto('/team')
    await page.getByRole('radio', { name: 'Workload' }).click()
    const firstRow = page.getByTestId('workload-row').first()
    await expect(firstRow.getByTestId('workload-open')).toHaveText(/^\d+ open · \d+$/)
    const name = (await firstRow.locator('span').first().textContent())!
    const open = Number((await firstRow.getByTestId('workload-open').textContent())!.split(' ')[0])
    expect(open).toBeGreaterThan(0)
    const row = page.getByTestId('workload-row').filter({ hasText: name }).getByTestId('workload-open')
    const fromId = await page.getByLabel('From member').locator('option', { hasText: name }).getAttribute('value')
    await page.getByLabel('From member').selectOption(fromId!)
    await page.getByLabel('To member').selectOption({ index: 2 })

    await page.getByRole('button', { name: 'Preview' }).click()
    await expect(page.getByTestId('rebalance-draft')).toContainText(`Previewing ${open} reassigned tasks`)
    await expect(page.getByTestId('rebalance-draft')).toContainText('nothing has been sent yet')
    await expect(row).toHaveText(/^0 open/)
    // nothing was written: the server still has the old assignment
    const before = await getJson<Array<{ userId: number; open: number }>>(page, '/api/metrics/workload')
    expect(before.find((d) => d.userId === Number(fromId))?.open).toBe(open)
    await page.getByRole('button', { name: 'Discard' }).click()
    await expect(page.getByTestId('rebalance-draft')).toHaveCount(0)
    await expect(row).toHaveText(new RegExp(`^${open} open`))

    await page.getByRole('button', { name: 'Preview' }).click()
    await expect(row).toHaveText(/^0 open/)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('status').filter({ hasText: `Reassigned ${open} tasks` })).toBeVisible()
    await expect(row).toHaveText(/^0 open/)
    await page.reload()
    await page.getByRole('radio', { name: 'Workload' }).click()
    await expect(page.getByTestId('workload-row').filter({ hasText: name }).getByTestId('workload-open')).toHaveText(/^0 open/)
  })

  test('leaving the page drops an unsaved rebalance preview', async ({ page }) => {
    await page.goto('/team')
    await page.getByRole('radio', { name: 'Workload' }).click()
    const firstRow = page.getByTestId('workload-row').first()
    await expect(firstRow.getByTestId('workload-open')).toHaveText(/^[1-9]\d* open/)
    const name = (await firstRow.locator('span').first().textContent())!
    const open = (await firstRow.getByTestId('workload-open').textContent())!
    const fromId = await page.getByLabel('From member').locator('option', { hasText: name }).getAttribute('value')
    await page.getByLabel('From member').selectOption(fromId!)
    await page.getByLabel('To member').selectOption({ index: 2 })
    await page.getByRole('button', { name: 'Preview' }).click()
    await expect(page.getByTestId('rebalance-draft')).toBeVisible()
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Overview' }).click()
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Team' }).click()
    await page.getByRole('radio', { name: 'Workload' }).click()
    await expect(page.getByTestId('rebalance-draft')).toHaveCount(0)
    await expect(page.getByTestId('workload-row').filter({ hasText: name }).getByTestId('workload-open')).toHaveText(open)
  })
})

test.describe('churn', () => {
  test('churning a customer zeroes its MRR, raises an alert and moves the overview KPI', async ({ page }) => {
    await page.goto('/')
    const kpi = page.getByTestId('kpi-mrr')
    await expect(kpi).toContainText('$')
    const mrrBefore = await kpi.textContent()
    await page.getByTestId('top-customers').getByRole('link').first().click()
    await expect(page).toHaveURL(/\/customers\/\d+/)
    await page.getByRole('button', { name: 'Edit' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Status').selectOption('churned')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByTestId('customer-mrr')).toContainText('$0')
    await expect(page.getByRole('status').filter({ hasText: 'churned' })).toBeVisible()
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Overview' }).click()
    await expect(page.getByTestId('kpi-mrr')).not.toHaveText(mrrBefore!)
  })
})
