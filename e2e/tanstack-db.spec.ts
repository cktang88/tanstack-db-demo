import { expect, test, type Page, type Request } from '@playwright/test'

// Behaviour that only exists because of TanStack DB.

const setChaos = (page: Page, chaos: { latencyMs: number; failRate: number }) =>
  page.request.put('/api/dev/chaos', { data: chaos })

/** Record API requests the browser makes while `fn` runs (SSE stream excluded). */
async function apiRequestsDuring(page: Page, fn: () => Promise<void>) {
  const seen: string[] = []
  const onRequest = (r: Request) => {
    const url = new URL(r.url())
    if (url.pathname.startsWith('/api/') && !url.pathname.endsWith('/stream'))
      seen.push(`${r.method()} ${url.pathname}${url.search}`)
  }
  page.on('request', onRequest)
  await fn()
  await page.waitForTimeout(300)
  page.off('request', onRequest)
  return seen
}

test.beforeAll(async ({ request }) => {
  await request.post('/api/dev/reset', { data: {} })
  await request.put('/api/dev/chaos', { data: { latencyMs: 120, failRate: 0 } })
})

test.afterEach(async ({ page }) => {
  await setChaos(page, { latencyMs: 120, failRate: 0 })
})

test('filtering, searching, sorting and paging the customers table makes zero network requests', async ({ page }) => {
  await page.goto('/customers')
  const table = page.getByTestId('customers-table')
  await expect(table.getByTestId('row')).toHaveCount(25)
  const requests = await apiRequestsDuring(page, async () => {
    await page.getByRole('button', { name: 'Active', pressed: false }).click()
    await page.getByRole('button', { name: 'Pro', pressed: false }).click()
    await page.getByRole('button', { name: /^owner/i }).click() // sort by a *joined* column
    await page.getByLabel('Next page').click()
    await page.getByLabel('Search customers').fill('a')
    await expect(table.getByTestId('row').first()).toContainText('Active')
  })
  expect(requests).toEqual([])
})

test('a write is reflected in every view instantly, with no refetches', async ({ page }) => {
  await page.goto('/')
  const mrrBefore = await page.getByTestId('kpi-mrr').textContent()
  // client-side navigation to a customer that is active
  await page.getByTestId('top-customers').getByRole('link').first().click()
  await expect(page).toHaveURL(/\/customers\/\d+/)
  const requests = await apiRequestsDuring(page, async () => {
    await page.getByRole('button', { name: 'Edit' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Status').selectOption('churned')
    await dialog.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByTestId('customer-mrr')).toContainText('$0')
    // churn alert comes from a live query effect (onEnter)
    await expect(page.getByRole('status').filter({ hasText: 'churned' })).toBeVisible()
    await page.getByRole('link', { name: 'Overview' }).click()
    await expect(page.getByTestId('kpi-mrr')).not.toHaveText(mrrBefore!)
  })
  // exactly one write, no invalidation-driven refetches of lists/metrics
  expect(requests.filter((r) => !r.startsWith('GET /api/events'))).toEqual(['POST /api/batch'])
})

test('changes made elsewhere stream in over SSE and update live queries', async ({ page }) => {
  await page.goto('/customers?q=Tyrell')
  const row = page.getByTestId('customers-table').getByTestId('row').first()
  const href = (await row.getByRole('link').first().getAttribute('href'))!
  const id = Number(href.split('/').pop())
  const current = await (await page.request.get(`/api/customers/${id}`)).json()
  const nextSeats = current.seats + 7
  // another client writes directly to the API
  await page.request.patch(`/api/customers/${id}`, { data: { seats: nextSeats } })
  await expect(row.locator('td').nth(6)).toHaveText(String(nextSeats))
})

test('localStorage collections sync across tabs (theme + pins)', async ({ page, context }) => {
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

test('row selection is a local-only collection: survives paging, summarised by a join', async ({ page }) => {
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

test('multi-collection delete transaction rolls back customers AND their invoices', async ({ page }) => {
  await page.goto('/invoices?status=open')
  const link = page.getByTestId('invoices-table').getByTestId('row').first().getByRole('link')
  const company = (await link.textContent())!
  await link.click()
  await expect(page.getByTestId('customer-invoices')).toBeVisible()
  await setChaos(page, { latencyMs: 800, failRate: 1 })
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'Delete' }).click()
  await expect(page).toHaveURL(/\/customers$/)
  await page.getByLabel('Search customers').fill(company)
  await expect(page.getByRole('alert').filter({ hasText: 'Delete failed' })).toBeVisible()
  // the customer is back, and so are its invoices
  await expect(page.getByTestId('customers-table').getByText(company, { exact: true }).first()).toBeVisible()
  await setChaos(page, { latencyMs: 120, failRate: 0 })
  await page.goto(`/invoices?q=${encodeURIComponent(company)}&status=open`)
  await expect(page.getByTestId('invoices-table').getByTestId('row').first()).toContainText(company)
})

test('staged transaction previews a reassignment, discard sends nothing, save sends one batch', async ({ page }) => {
  await page.goto('/team')
  await page.getByRole('radio', { name: 'Workload' }).click()
  const firstRow = page.getByTestId('workload-row').first()
  const name = (await firstRow.locator('span').first().textContent())!
  const open = Number((await firstRow.getByTestId('workload-open').textContent())!.split(' ')[0])
  expect(open).toBeGreaterThan(0)
  const fromId = await page.getByLabel('From member').locator('option', { hasText: name }).getAttribute('value')
  await page.getByLabel('From member').selectOption(fromId!)
  await page.getByLabel('To member').selectOption({ index: 2 })

  const discarded = await apiRequestsDuring(page, async () => {
    await page.getByRole('button', { name: 'Preview' }).click()
    await expect(page.getByTestId('rebalance-draft')).toContainText(`${open}`)
    await expect(page.getByTestId('workload-row').filter({ hasText: name }).getByTestId('workload-open')).toHaveText(/^0 open/)
    await page.getByRole('button', { name: 'Discard' }).click()
    await expect(page.getByTestId('workload-row').filter({ hasText: name }).getByTestId('workload-open')).toHaveText(
      new RegExp(`^${open} open`),
    )
  })
  expect(discarded).toEqual([])

  const saved = await apiRequestsDuring(page, async () => {
    await page.getByRole('button', { name: 'Preview' }).click()
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('status').filter({ hasText: `Reassigned ${open} tasks` })).toBeVisible()
  })
  expect(saved).toEqual(['POST /api/batch'])
  await page.reload()
  await page.getByRole('radio', { name: 'Workload' }).click()
  await expect(page.getByTestId('workload-row').filter({ hasText: name }).getByTestId('workload-open')).toHaveText(/^0 open/)
})

test('collection schema (Effect Schema) rejects invalid inserts before they reach the UI or network', async ({ page }) => {
  await page.goto('/projects/3')
  const todo = page.getByTestId('column-todo')
  await expect(todo.getByTestId('task-card').first()).toBeVisible()
  const before = await todo.getByTestId('task-card').count()
  const requests = await apiRequestsDuring(page, async () => {
    await todo.getByLabel('New task title').fill('ab')
    await todo.getByRole('button', { name: 'Add' }).click()
    await expect(todo.getByText('Title must be at least 3 characters')).toBeVisible()
  })
  expect(requests).toEqual([])
  await expect(todo.getByTestId('task-card')).toHaveCount(before)
})

test('pending writes are visible per row ($hasPendingWrites)', async ({ page }) => {
  await page.goto('/projects/4')
  await setChaos(page, { latencyMs: 1500, failRate: 0 })
  const card = page.getByTestId('column-todo').getByTestId('task-card').first()
  const title = (await card.getByTestId('task-title').textContent())!
  await card.getByLabel('Move right').click()
  const moved = page.getByTestId('column-in_progress').getByTestId('task-card').filter({ hasText: title })
  await expect(moved).toHaveAttribute('data-pending', 'true')
  await expect(moved).not.toHaveAttribute('data-pending', 'true', { timeout: 5000 })
})

test('debounced autosave: many keystrokes, one request', async ({ page }) => {
  await page.goto('/projects/5')
  const box = page.getByLabel('Project description')
  const requests = await apiRequestsDuring(page, async () => {
    await box.fill('')
    await box.pressSequentially('Rolled out to every region', { delay: 20 })
    await page.waitForTimeout(1200)
  })
  expect(requests.filter((r) => r === 'POST /api/batch')).toHaveLength(1)
  await page.reload()
  await expect(page.getByLabel('Project description')).toHaveValue('Rolled out to every region')
})

test('on-demand collections push filters, order and windows down to the API', async ({ page }) => {
  const requests = await apiRequestsDuring(page, async () => {
    await page.goto('/activity')
    await expect(page.getByTestId('activity-item')).toHaveCount(30)
    await page.getByRole('radio', { name: 'Invoices' }).click()
    await expect(page.getByTestId('activity-item').first()).toContainText('Invoice')
    await page.mouse.wheel(0, 20_000)
    await expect.poll(() => page.getByTestId('activity-item').count()).toBeGreaterThan(30)
  })
  const events = requests.filter((r) => r.startsWith('GET /api/events?')).map((r) => decodeURIComponent(r))
  expect(events).toContain('GET /api/events?sort=-id&limit=31')
  expect(events).toContain('GET /api/events?sort=-id&limit=31&category[eq]=invoice')
  // the next page is a delta load (offset), not a re-fetch of everything so far
  expect(events).toContain('GET /api/events?sort=-id&limit=30&offset=31&category[eq]=invoice')
  // never an unbounded load of the event log: the only un-limited requests are single-row boundary lookups
  expect(events.filter((r) => r.includes('limit=10000') && !r.includes('id[eq]='))).toEqual([])
})
