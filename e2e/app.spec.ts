import { expect, test, type Page } from '@playwright/test'
import { resetDemo } from './helpers'

const setChaos = (page: Page, chaos: { latencyMs: number; failRate: number }) =>
  page.request.put('/api/dev/chaos', { data: chaos })

test.beforeAll(({ playwright, baseURL }) => resetDemo(playwright, baseURL))

test.afterEach(async ({ page }) => {
  await setChaos(page, { latencyMs: 120, failRate: 0 })
})

test.describe('overview', () => {
  test('shows KPIs, charts and live activity', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle(/Overview/)
    await expect(page.getByTestId('kpi-mrr')).toContainText('$')
    await expect(page.getByTestId('kpi-active')).toContainText(/\d/)
    await expect(page.getByTestId('revenue-chart').locator('svg').first()).toBeVisible()
    await expect(page.getByTestId('signups-chart').locator('svg').first()).toBeVisible()
    await expect(page.getByTestId('recent-activity').locator('li')).toHaveCount(8)
    await expect(page.getByTestId('top-customers').locator('li')).toHaveCount(6)
  })

  test('switches revenue range', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('radio', { name: '6m' }).click()
    await expect(page.getByRole('radio', { name: '6m' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('revenue-chart').locator('svg').first()).toBeVisible()
  })
})

test.describe('customers table', () => {
  test('paginates, sorts and keeps state in the URL', async ({ page }) => {
    await page.goto('/customers')
    const table = page.getByTestId('customers-table')
    await expect(table.getByTestId('row')).toHaveCount(25)
    await expect(table.getByTestId('page-info')).toHaveText('1–25 of 1,500')

    await page.getByLabel('Next page').click()
    await expect(page).toHaveURL(/page=2/)
    await expect(table.getByTestId('page-info')).toHaveText('26–50 of 1,500')

    await page.getByLabel('Rows per page').selectOption('50')
    await expect(table.getByTestId('row')).toHaveCount(50)
    await expect(page).toHaveURL(/pageSize=50/)
    await expect(page).not.toHaveURL(/[?&]page=/) // back to page 1 (default stripped from URL)
    await expect(table.getByTestId('page-info')).toHaveText('1–50 of 1,500')

    // numeric columns sort descending first, the second click flips to ascending
    await page.getByRole('button', { name: /^mrr/i }).click()
    await expect(page).toHaveURL(/sort=-mrr/)
    await page.getByRole('button', { name: /^mrr/i }).click()
    await expect(page).toHaveURL(/sort=mrr/)
    await expect(page.getByRole('columnheader', { name: /mrr/i })).toHaveAttribute('aria-sort', 'ascending')
    await page.getByRole('button', { name: /^mrr/i }).click()
    await page.getByRole('button', { name: /^mrr/i }).click()
    await expect(page).toHaveURL(/sort=-mrr/)
    const first = await table.getByTestId('row').first().locator('td').nth(7).textContent()
    const second = await table.getByTestId('row').nth(1).locator('td').nth(7).textContent()
    const n = (s: string | null) => Number(s?.replace(/[$,]/g, ''))
    expect(n(first)).toBeGreaterThanOrEqual(n(second))

    // reload: state restored from the URL
    await page.reload()
    await expect(table.getByTestId('row')).toHaveCount(50)
    await expect(page.getByRole('columnheader', { name: /mrr/i })).toHaveAttribute('aria-sort', 'descending')
  })

  test('filters by status, plan and search', async ({ page }) => {
    await page.goto('/customers')
    const table = page.getByTestId('customers-table')
    await page.getByRole('button', { name: 'Churned', pressed: false }).click()
    await expect(page).toHaveURL(/status=.*churned/)
    await expect(table.getByTestId('row').first()).toContainText('Churned')
    const churnedCount = await table.getByTestId('page-info').textContent()
    expect(churnedCount).not.toContain('1,500')

    await page.getByRole('button', { name: 'Enterprise', pressed: false }).click()
    await expect(page).toHaveURL(/plan=.*enterprise/)
    await expect
      .poll(async () => {
        const texts = await table.getByTestId('row').allTextContents()
        return texts.length > 0 && texts.every((t) => t.includes('Churned') && t.includes('Enterprise'))
      })
      .toBe(true)

    await page.getByLabel('Search customers').fill('zzzz-no-match')
    await expect(table).toContainText('No results.')
  })

  test('creates a customer with validation', async ({ page }) => {
    await page.goto('/customers')
    await page.getByRole('button', { name: '+ New customer' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Company').fill('Q')
    await dialog.getByRole('button', { name: 'Create customer' }).click()
    await expect(dialog.getByText('Must be at least 2 characters').first()).toBeVisible()

    await dialog.getByLabel('Company').fill('Playwright Industries')
    await dialog.getByLabel('Contact name').fill('Pat Wright')
    await dialog.getByLabel('Email').fill('pat@playwright.test')
    await dialog.getByLabel('Plan').selectOption('enterprise')
    await dialog.getByLabel('Status').selectOption('active')
    await dialog.getByLabel('Seats').fill('3')
    await dialog.getByRole('button', { name: 'Create customer' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('status').filter({ hasText: 'Customer created' })).toBeVisible()

    await page.getByLabel('Search customers').fill('Playwright Industries')
    const row = page.getByTestId('customers-table').getByTestId('row')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('$387') // 3 seats * $129
  })

  test('bulk updates selected rows', async ({ page }) => {
    await page.goto('/customers?status=trial&pageSize=10')
    const table = page.getByTestId('customers-table')
    await expect(table.getByTestId('row')).toHaveCount(10)
    const names = await table.getByTestId('row').locator('td:nth-child(2)').allTextContents()
    await table.getByLabel('Select row').nth(0).check()
    await table.getByLabel('Select row').nth(1).check()
    await expect(table.getByTestId('bulk-bar')).toContainText('2 selected')
    await table.getByRole('button', { name: 'Mark active' }).click()
    // optimistic: rows flip immediately, then disappear from the "trial" filter after refetch
    await expect(table.getByTestId('row').filter({ hasText: names[0]! })).toHaveCount(0)
    await page.goto(`/customers?q=${encodeURIComponent(names[0]!)}&status=active`)
    await expect(table.getByTestId('row').first()).toContainText('Active')
  })
})

test.describe('customer detail', () => {
  test('edits a customer and marks an invoice paid', async ({ page }) => {
    await page.goto('/invoices?status=open&pageSize=10')
    const link = page.getByTestId('invoices-table').getByTestId('row').first().getByRole('link')
    await expect(link).not.toBeEmpty()
    await link.click()
    await expect(page).toHaveURL(/\/customers\/\d+/)

    const invoices = page.getByTestId('customer-invoices')
    await expect(invoices.getByRole('button', { name: 'Mark paid' }).first()).toBeVisible()
    const paidBefore = await invoices.getByText('Paid', { exact: true }).count()
    await invoices.getByRole('button', { name: 'Mark paid' }).first().click()
    await expect(invoices.getByText('Paid', { exact: true })).toHaveCount(paidBefore + 1)

    await page.getByRole('button', { name: 'Edit' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Status').selectOption('active')
    await dialog.getByLabel('Plan').selectOption('pro')
    await dialog.getByLabel('Seats').fill('10')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByTestId('customer-mrr')).toContainText('$490')
    await page.reload()
    await expect(page.getByTestId('customer-mrr')).toContainText('$490')
  })

  test('shows a not-found state', async ({ page }) => {
    await page.goto('/customers/999999')
    await expect(page.getByRole('alert')).toContainText('Not found')
  })
})

test.describe('invoices', () => {
  test('filters overdue and marks one paid', async ({ page }) => {
    await page.goto('/invoices')
    await page.getByRole('button', { name: 'Overdue', pressed: false }).click()
    const table = page.getByTestId('invoices-table')
    await expect(table.getByTestId('row').first()).toContainText('Overdue')
    const before = await table.getByTestId('page-info').textContent()
    const number = await table.getByTestId('row').first().locator('td').first().textContent()
    await table.getByTestId('row').first().getByRole('button', { name: 'Mark paid' }).click()
    await expect(table.getByTestId('row').filter({ hasText: number! })).toHaveCount(0)
    await expect(table.getByTestId('page-info')).not.toHaveText(before!)
  })
})

test.describe('project board', () => {
  test('creates, moves and deletes tasks', async ({ page }) => {
    await page.goto('/projects')
    await page.getByTestId('project-card').first().click()
    await expect(page.getByTestId('board')).toBeVisible()

    const todo = page.getByTestId('column-todo')
    const inProgress = page.getByTestId('column-in_progress')
    await todo.getByLabel('New task title').fill('E2E task')
    await todo.getByRole('button', { name: 'Add' }).click()
    const card = page.getByTestId('task-card').filter({ hasText: 'E2E task' })
    await expect(card).toHaveCount(1)
    await expect(card).not.toHaveClass(/opacity-60/) // server confirmed

    const inProgressCount = Number(await inProgress.getByTestId('column-count').textContent())
    await card.getByLabel('Move right').click()
    await expect(inProgress.getByTestId('task-card').filter({ hasText: 'E2E task' })).toHaveCount(1)
    await expect(inProgress.getByTestId('column-count')).toHaveText(String(inProgressCount + 1))

    await page.reload()
    await expect(inProgress.getByTestId('task-card').filter({ hasText: 'E2E task' })).toHaveCount(1)

    await page.getByTestId('task-card').filter({ hasText: 'E2E task' }).hover()
    await page.getByLabel('Delete E2E task').click()
    await expect(page.getByTestId('task-card').filter({ hasText: 'E2E task' })).toHaveCount(0)
  })

  test('rolls back an optimistic move when the server fails', async ({ page }) => {
    await page.goto('/projects/2')
    const todo = page.getByTestId('column-todo')
    const card = todo.getByTestId('task-card').first()
    const title = (await card.getByTestId('task-title').textContent())!
    await setChaos(page, { latencyMs: 600, failRate: 1 })
    await card.getByLabel('Move right').click()
    // optimistic: moves instantly...
    await expect(page.getByTestId('column-in_progress').getByText(title, { exact: true })).toBeVisible()
    // ...then rolls back with an error toast
    await expect(page.getByRole('alert').filter({ hasText: 'rolled back' })).toBeVisible()
    await expect(todo.getByText(title, { exact: true }).first()).toBeVisible()
  })
})

test.describe('team, activity, settings', () => {
  test('changes a role optimistically and persists it', async ({ page }) => {
    await page.goto('/team')
    const row = page.getByTestId('member-row').filter({ hasText: 'Hedy Turing' })
    const select = row.getByRole('combobox')
    const next = (await select.inputValue()) === 'viewer' ? 'admin' : 'viewer'
    const saved = page.waitForResponse((r) => r.request().method() !== 'GET' && /\/api\/(users|batch)/.test(r.url()))
    await select.selectOption(next)
    await expect(select).toHaveValue(next)
    await saved
    await page.reload()
    await expect(page.getByTestId('member-row').filter({ hasText: 'Hedy Turing' }).getByRole('combobox')).toHaveValue(next)

    await page.getByTestId('member-row').filter({ hasText: 'Hedy Turing' }).getByRole('button').first().click()
    await expect(page.getByTestId('member-tasks').or(page.getByText('No tasks assigned.'))).toBeVisible()
  })

  test('activity feed loads more on scroll', async ({ page }) => {
    await page.goto('/activity')
    const items = page.getByTestId('activity-item')
    await expect(items).toHaveCount(30)
    await items.last().scrollIntoViewIfNeeded()
    await page.mouse.wheel(0, 5000)
    await expect.poll(() => items.count()).toBeGreaterThan(30)
    await page.getByRole('radio', { name: 'Invoices' }).click()
    await expect(items.first()).toContainText('Invoice')
  })

  test('theme preference persists', async ({ page }) => {
    await page.goto('/settings')
    await page.getByRole('radio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.reload()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.getByRole('radio', { name: 'Light' }).click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
  })
})
