import { expect, test, type Page, type Request } from '@playwright/test'

// Properties specific to the TanStack DB data layer (requests made, transactions,
// push-down). User-visible features both branches share are in features.spec.ts.

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

/** Big resources are on-demand collections: never loaded whole. */
const BIG =
  /^GET \/api\/(customers|invoices|payments|subscriptions|contacts|customer-tags|invoice-line-items|usage-daily|events|audit-log)\?/

test('the customers table pushes every window down to the API; revisiting a window makes no request', async ({ page }) => {
  await page.goto('/customers')
  const table = page.getByTestId('customers-table')
  await expect(table.getByTestId('row')).toHaveCount(25)
  const requests = await apiRequestsDuring(page, async () => {
    await page.getByRole('button', { name: 'Active', pressed: false }).click()
    await page.getByRole('button', { name: 'Pro', pressed: false }).click()
    await page.getByRole('button', { name: /^owner/i }).click() // owner name: a client-derived sort key
    await expect(page).toHaveURL(/sort=owner/)
    await page.getByLabel('Next page').click()
    await expect(table.getByTestId('page-info')).toHaveText(/^26–50 of /)
  })
  const reads = requests.map(decodeURIComponent)
  // filters and the composite sort key (owner name, then id: unique, so the window is exact); the
  // next page moves the same window (setWindow), so it asks for just that page — each one request
  expect(reads).toContain('GET /api/customers?status[in]=active&plan[in]=pro&sort=owner,id&limit=25')
  expect(reads).toContain('GET /api/customers?status[in]=active&plan[in]=pro&sort=owner,id&limit=25&offset=25')
  // the header's count and MRR over *all* matches is a server total
  expect(reads).toContain('GET /api/customers?status=active&plan=pro&limit=0&sum=mrr')
  // never a whole table, never a tie-group download: every customers read is a bounded window or a total
  for (const r of reads.filter((r) => r.startsWith('GET /api/customers')))
    expect(r).toMatch(/[?&](limit=(0|25)(&offset=25)?$|limit=0&sum=mrr$)/)

  // back to a window that was loaded before: served from the collection and the query cache
  const revisit = await apiRequestsDuring(page, async () => {
    await page.getByLabel('Previous page').click()
    await expect(table.getByTestId('page-info')).toHaveText(/^1–25 of /)
    await expect(table.getByTestId('row')).toHaveCount(25)
  })
  expect(revisit).toEqual([])

  // search is the server's ?q= (debounced): the derived searchText keeps exactly those rows locally
  const searched = await apiRequestsDuring(page, async () => {
    await page.getByLabel('Search customers').fill('labs')
    await expect(page).toHaveURL(/q=labs/)
    await expect(table.getByTestId('row').first()).toContainText(/labs/i)
  })
  expect(searched.map(decodeURIComponent)).toContain(
    'GET /api/customers?status[in]=active&plan[in]=pro&q=labs&sort=owner,id&limit=25',
  )
})

test('a write is one batch request; on-demand windows on screen are re-read, nothing is loaded whole', async ({ page }) => {
  await page.goto('/')
  const mrrBefore = await page.getByTestId('kpi-mrr').textContent()
  // client-side navigation to a customer that is active
  await page.getByTestId('top-customers').getByRole('link').first().click()
  await expect(page).toHaveURL(/\/customers\/\d+/)
  const id = Number(new URL(page.url()).pathname.split('/').pop())
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
    // optimistic: MRR drops before the server answers
    await expect(page.getByTestId('customer-mrr')).toContainText('$0')
    // the churn alert compares the committed row with the synced one (see db/alerts.ts)
    await expect(page.getByRole('status').filter({ hasText: 'churned' })).toBeVisible()
    await page.getByRole('link', { name: 'Overview' }).click()
    await expect(page.getByTestId('kpi-mrr')).not.toHaveText(mrrBefore!)
  })
  // exactly one write…
  expect(requests.filter((r) => !r.startsWith('GET '))).toEqual(['POST /api/batch'])
  const reads = requests.filter((r) => r.startsWith('GET ')).map(decodeURIComponent)
  // …after which the query collection re-reads the customer on screen (query-db-collection
  // revalidates active on-demand subsets after a direct write: a changed row can enter or leave a
  // window), and the overview's top-accounts window loads again when it is shown (the write
  // dropped its cached copy). Every customers read is that one customer or that small window.
  const window6 = 'status\\[eq\\]=active&sort=-mrr,-id&limit=6'
  for (const r of reads.filter((r) => r.startsWith('GET /api/customers?') && !r.includes('limit=0')))
    expect(r).toMatch(new RegExp(`^GET /api/customers\\?(id\\[eq\\]=${id}&limit=10000|${window6})$`))
  // aggregates over every customer are server queries, re-read after the change
  expect(reads).toContain('GET /api/metrics/overview')
  // nothing of the big tables is read whole: by key, by customer, or a small window
  for (const r of reads.filter((r) => BIG.test(r)))
    expect(r).toMatch(/[?&](id\[eq\]|customerId\[eq\]|status\[eq\])=|[?&]limit=(0|\d{1,2})(&|$)/)
})

test('a change made elsewhere is written into the loaded window over SSE', async ({ page }) => {
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
  // The pushed row is written into the collection (the cell updates from it); the only customer
  // reads are the library's revalidation of the window on screen (the same request that loaded
  // it) and the server totals — no other window, no table load.
  const reads = requests.filter((r) => r.startsWith('GET /api/customers')).map(decodeURIComponent)
  for (const r of reads)
    // (the window's search term is pushed down lower-cased: the server's search is case-insensitive)
    expect(r).toMatch(/^GET \/api\/customers\?(q=tyrell&sort=-createdAt,-id&limit=25|q=Tyrell&limit=0&sum=mrr|limit=0)$/)
})

test('multi-collection archive transaction rolls back customers AND their invoices', async ({ page }) => {
  await page.goto('/invoices?status=open')
  const link = page.getByTestId('invoices-table').getByTestId('row').first().getByRole('link')
  const company = (await link.textContent())!
  await link.click()
  const detailUrl = page.url()
  const invoices = page.getByTestId('customer-invoices').getByRole('row')
  await expect(invoices.first()).toBeVisible()
  const invoiceCount = await invoices.count()
  await setChaos(page, { latencyMs: 2500, failRate: 1 })
  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: 'Archive' }).click()
  await expect(page).toHaveURL(/\/customers$/)
  // straight back while the batch is still in flight: the customer AND its invoices are
  // optimistically gone (one transaction across two collections)…
  const reads = await apiRequestsDuring(page, async () => {
    await page.goBack()
    await expect(page).toHaveURL(detailUrl)
    await expect(page.getByRole('alert')).toContainText('Not found')
    // …and after the server refuses, both come back in place — restored from the client's own
    // synced rows (the server never changed), not refetched
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(company, { timeout: 10_000 })
    await expect(invoices).toHaveCount(invoiceCount)
  })
  expect(reads.filter((r) => r.startsWith('GET /api/invoices'))).toEqual([])
  await expect(page.getByRole('alert').filter({ hasText: 'Archive failed' })).toBeVisible()
})

test('the customer detail page loads only that customer: by id and customerId push-down', async ({ page }) => {
  const requests = await apiRequestsDuring(page, async () => {
    await page.goto('/customers/7')
    await expect(page.getByTestId('customer-health')).toContainText('API calls')
    await expect(page.getByTestId('usage')).toHaveAttribute('data-state', 'ready')
  })
  const reads = requests.map(decodeURIComponent).filter((r) => BIG.test(r) && !r.includes('limit=0'))
  expect(reads).toContain('GET /api/customers?id[eq]=7&limit=10000')
  expect(reads).toContain('GET /api/invoices?customerId[eq]=7&limit=10000')
  expect(reads).toContain('GET /api/subscriptions?customerId[eq]=7&limit=10000')
  for (const r of reads) expect(r).toMatch(/[?&](id\[eq\]=7|customerId\[eq\]=7)(&|$)/)
})

test('no page ever loads a big table whole: every read is a window, a key lookup or a server total', async ({ page }) => {
  const requests = await apiRequestsDuring(page, async () => {
    for (const path of ['/', '/analytics', '/customers?sort=plan', '/invoices?sort=company', '/billing', '/products', '/audit'])
      await page.goto(path).then(() => page.waitForLoadState('networkidle'))
    // client-side navigation between pages whose windows overlap (rows shown from local state while
    // the previous page's windows are released) must not turn into a full-table "repair" either
    for (const link of ['Customers', 'Overview', 'Invoices', 'Billing', 'Overview', 'Activity', 'Customers']) {
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: link }).click()
      await page.waitForTimeout(150)
    }
    await page.waitForLoadState('networkidle')
  })
  const unbounded = requests
    .map(decodeURIComponent)
    .filter((r) => BIG.test(r) && /[?&]limit=10000(&|$)/.test(r) && !/[?&](id|customerId|invoiceId)\[(eq|in)\]=/.test(r))
  expect(unbounded).toEqual([])
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
