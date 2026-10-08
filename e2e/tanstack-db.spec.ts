import { expect, test, type Page, type Request } from '@playwright/test'

// Behaviour that only exists because of TanStack DB.

const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const usd = (n: number) => usdFmt.format(n)
const dollars = (text: string) => Number(text.replace(/[^0-9.-]/g, ''))

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

test.beforeAll(async ({ playwright, baseURL }) => {
  const owner = await playwright.request.newContext({ baseURL, storageState: 'e2e/.auth/owner.json' })
  await owner.post('/api/dev/reset', { data: {} })
  await owner.put('/api/dev/chaos', { data: { latencyMs: 120, failRate: 0 } })
  await owner.dispose()
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
  // let the page's first loads (health view, contacts, tags, usage rollup) finish before measuring
  await expect(page.getByTestId('customer-health')).toContainText('API calls')
  await expect(page.getByTestId('tags').getByRole('button').first()).toBeVisible()
  await expect(page.getByTestId('contacts').getByRole('listitem').first()).toBeVisible()
  await expect(page.getByTestId('usage')).toHaveAttribute('data-state', 'ready')
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
  // exactly one write…
  expect(requests.filter((r) => !r.startsWith('GET '))).toEqual(['POST /api/batch'])
  // …and no refetch of any list, detail or metric: every view above was updated from local data.
  // The only reads allowed are server-computed rows nobody can derive locally: the customer's
  // health (a SQL view the server re-announces) and the activity windows (new server events).
  const reads = requests.filter((r) => r.startsWith('GET ')).map(decodeURIComponent)
  expect(reads.filter((r) => !/^GET \/api\/(customer-health\?customerId\[eq\]=\d+&|events)/.test(r))).toEqual([])
})

test('changes made elsewhere stream in over SSE and update live queries', async ({ page }) => {
  await page.goto('/customers?q=Tyrell')
  const row = page.getByTestId('customers-table').getByTestId('row').first()
  const href = (await row.getByRole('link').first().getAttribute('href'))!
  const id = Number(href.split('/').pop())
  const current = await (await page.request.get(`/api/customers/${id}`)).json()
  const nextSeats = current.seats + 7
  const requests = await apiRequestsDuring(page, async () => {
    // another client writes directly to the API
    await page.request.patch(`/api/customers/${id}`, { data: { seats: nextSeats } })
    await expect(row.locator('td').nth(6)).toHaveText(String(nextSeats))
  })
  // the pushed row was written into the collection: the table did not refetch customers
  expect(requests.filter((r) => r.startsWith('GET /api/customers'))).toEqual([])
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

test('multi-collection archive transaction rolls back customers AND their invoices', async ({ page }) => {
  await page.goto('/invoices?status=open')
  const link = page.getByTestId('invoices-table').getByTestId('row').first().getByRole('link')
  const company = (await link.textContent())!
  await link.click()
  await expect(page.getByTestId('customer-invoices')).toBeVisible()
  await setChaos(page, { latencyMs: 800, failRate: 1 })
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'Archive' }).click()
  await expect(page).toHaveURL(/\/customers$/)
  await page.getByLabel('Search customers').fill(company)
  await expect(page.getByRole('alert').filter({ hasText: 'Archive failed' })).toBeVisible()
  // the customer is back, and so are its invoices — checked in-app, without a reload, so this is the
  // client's rollback of the cascaded invoice deletes and not a fresh fetch from the untouched server
  await expect(page.getByTestId('customers-table').getByText(company, { exact: true }).first()).toBeVisible()
  const reads = await apiRequestsDuring(page, async () => {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Invoices' }).click()
    await page.getByLabel('Search invoices').fill(company)
    await expect(page.getByTestId('invoices-table').getByTestId('row').first()).toContainText(company)
  })
  expect(reads.filter((r) => r.startsWith('GET /api/invoices'))).toEqual([])
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

test('on-demand windows over a cursor-only feed (createCursorPager) and push-down to the API', async ({ page }) => {
  const requests = await apiRequestsDuring(page, async () => {
    await page.goto('/activity')
    await expect(page.getByTestId('activity-item')).toHaveCount(30)
    await page.getByRole('radio', { name: 'Invoices' }).click()
    await expect(page.getByTestId('activity-item').first()).toContainText('Invoice')
    await page.mouse.wheel(0, 20_000)
    await expect.poll(() => page.getByTestId('activity-item').count()).toBeGreaterThan(30)
  })
  const events = requests.filter((r) => r.startsWith('GET /api/events')).map((r) => decodeURIComponent(r))
  // unfiltered newest-first windows are served by createCursorPager from the keyset feed…
  expect(events).toContain('GET /api/events/feed?limit=50')
  expect(events).toContain('GET /api/events/feed?limit=50&type=invoice.')
  // …and scrolling continues from the opaque cursor instead of an offset that drifts as events arrive
  expect(events.some((r) => /^GET \/api\/events\/feed\?limit=50&cursor=\d+&type=invoice\.$/.test(r))).toBe(true)
  // never an unbounded load of the event log
  expect(events.filter((r) => r.includes('limit=10000') && !r.includes('id[eq]='))).toEqual([])
})

test('a partial payment goes to the append-only ledger optimistically; the balance is a live aggregate', async ({ page }) => {
  await page.goto('/invoices?status=open')
  await page.getByTestId('invoices-table').getByTestId('row').first().getByRole('link').click()
  const balance = page.getByTestId('balance-value')
  await expect(balance).toBeVisible()
  const row = page
    .getByTestId('customer-invoices')
    .getByRole('row')
    .filter({ hasText: /open|overdue/i })
    .first()
  const detail = page.getByTestId('invoice-detail')
  // line items and payments are on-demand collections: fetched for this invoice only
  const requests = await apiRequestsDuring(page, async () => {
    await row.click()
    await expect(detail.getByTestId('invoice-payments')).toBeVisible()
  })
  const loads = requests.map(decodeURIComponent)
  expect(loads.some((r) => r.startsWith('GET /api/invoice-line-items?invoiceId[eq]='))).toBe(true)
  expect(loads.some((r) => r.startsWith('GET /api/payments?invoiceId[eq]='))).toBe(true)
  const before = await balance.textContent()
  await setChaos(page, { latencyMs: 1500, failRate: 0 })
  await detail.getByLabel('Payment amount').fill('1')
  await detail.getByRole('button', { name: 'Record payment' }).click()
  // the ledger row and the new balance show up before the server has answered
  await expect(detail.getByTestId('invoice-payments').getByText('$1', { exact: true })).toBeVisible({ timeout: 1000 })
  await expect(balance).toHaveText(usd(dollars(before!) - 1), { timeout: 1000 })
  // once committed, the reference is the server's (the placeholder is never stored) …
  await expect(detail.getByTestId('invoice-payments')).not.toContainText('pending', { timeout: 5000 })
  // … and the live client-side balance agrees with the server's trigger-maintained rollup
  const customerId = Number(new URL(page.url()).pathname.split('/').pop())
  const rollup = (await (await page.request.get(`/api/customer-balances/${customerId}`)).json()) as { outstanding: number }
  await expect(balance).toHaveText(usd(rollup.outstanding / 100))
})

test('many-to-many tag toggles and team membership are optimistic inserts/deletes on join tables', async ({ page }) => {
  await page.goto('/customers/1')
  const tag = page.getByTestId('tags').getByRole('button').first()
  const pressed = await tag.getAttribute('aria-pressed')
  await tag.click()
  await expect(tag).toHaveAttribute('aria-pressed', pressed === 'true' ? 'false' : 'true')
  await page.reload()
  await expect(page.getByTestId('tags').getByRole('button').first()).toHaveAttribute(
    'aria-pressed',
    pressed === 'true' ? 'false' : 'true',
  )

  await page.goto('/team')
  await page.getByRole('radio', { name: 'Teams' }).click()
  const team = page.getByTestId('teams').locator('section').first()
  const add = team.getByRole('combobox')
  const name = (await add.locator('option').nth(1).textContent())!
  await add.selectOption({ index: 1 })
  const chip = team.getByRole('button', { name: new RegExp(`^Remove ${name} from`) })
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(chip).toHaveCount(0)
})

test('a server-side refusal (409: task has comments) rolls the optimistic delete back', async ({ page }) => {
  await page.goto('/projects/1')
  const card = page.getByTestId('task-card').first()
  const title = (await card.getByTestId('task-title').textContent())!
  await card.getByTestId('task-title').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Comment').fill('Blocking the delete')
  await dialog.getByRole('button', { name: 'Post' }).click()
  await expect(dialog.getByText('Blocking the delete')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByTestId('task-card').filter({ hasText: title }).first().hover()
  await page
    .getByRole('button', { name: `Delete ${title}` })
    .first()
    .click()
  await expect(page.getByRole('alert').filter({ hasText: 'Could not delete task' })).toBeVisible()
  await expect(page.getByTestId('task-card').filter({ hasText: title }).first()).toBeVisible()
})

test('a viewer gets read-only UI driven by the same permissions the API enforces', async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, storageState: 'e2e/.auth/viewer.json' })
  const page = await ctx.newPage()
  await page.goto('/customers/1')
  await expect(page.getByText(/read-only — owned by/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edit' })).toBeDisabled()
  await page.goto('/customers')
  await expect(page.getByRole('button', { name: '+ New customer' })).toHaveCount(0)
  await ctx.close()
})

test("a member's bulk action only sends the rows they may edit (no 403, no rollback)", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, storageState: 'e2e/.auth/member.json' })
  const page = await ctx.newPage()
  const batches: number[] = []
  page.on('response', (r) => {
    if (r.url().endsWith('/api/batch')) batches.push(r.status())
  })
  await page.goto('/customers?status=active')
  const table = page.getByTestId('customers-table')
  await expect(table.getByTestId('row')).toHaveCount(25)
  await table.getByLabel('Select all rows on page').check()
  await page.getByRole('button', { name: 'Mark active' }).click()
  // rows owned by other people are filtered out up front instead of failing the whole atomic batch
  await expect(page.getByRole('status').filter({ hasText: /Skipped \d+ customers?/ })).toBeVisible()
  await expect(page.getByRole('alert').filter({ hasText: 'rolled back' })).toHaveCount(0)
  await expect.poll(() => batches.every((s) => s === 200)).toBe(true)
  await ctx.close()
})
