import { expect, test } from '@playwright/test'
import { pageAs } from './helpers'

test('billing records a partial payment, then settles the invoice', async ({ browser }) => {
  const page = await pageAs(browser, 'billing')
  await page.goto('/invoices?status=open&sort=-amount')
  const first = page.getByTestId('invoices-table').getByTestId('row').first()
  const number = (await first.locator('td').first().textContent())!
  await first.getByRole('link').click()
  await page.getByTestId('customer-invoices').getByText(number).click()
  const detail = page.getByTestId('invoice-detail')
  await detail.getByLabel('Payment amount').fill('1')
  await detail.getByLabel('Payment method').selectOption('wire')
  await detail.getByRole('button', { name: 'Record payment' }).click()
  await expect(detail.getByTestId('invoice-payments')).toContainText('$1')
  const row = page.getByTestId('customer-invoices').locator('tr', { hasText: number }).first()
  await expect(row).toContainText('Open')
  await detail.getByRole('button', { name: 'Record payment' }).click() // remainder
  await expect(row).toContainText('Paid')
  await page.close()
})

test('task dialog: append-only comments and time tracking', async ({ page }) => {
  await page.goto('/projects/1')
  await page.getByTestId('task-card').first().getByTestId('task-title').click()
  const dialog = page.getByTestId('task-dialog')
  await dialog.getByLabel('Comment').fill('E2E comment')
  await dialog.getByRole('button', { name: 'Post' }).click()
  await expect(dialog.getByTestId('comments')).toContainText('E2E comment')
  const header = dialog.getByText(/h total/)
  const before = await header.textContent()
  await dialog.getByLabel('Minutes').fill('90')
  await dialog.getByRole('button', { name: 'Log time' }).click()
  await expect(header).not.toHaveText(before!)
})

test('customer subscriptions drive MRR; contacts and tags are many-to-many', async ({ page }) => {
  await page.goto('/customers?plan=pro&status=active&sort=-mrr')
  await page.getByTestId('customers-table').getByTestId('row').first().getByRole('link').first().click()
  const mrr = page.getByTestId('customer-mrr')
  const before = await mrr.textContent()
  await page.getByLabel('Add-on').selectOption({ label: 'Priority support' })
  await page.getByLabel('Quantity').fill('1')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(mrr).not.toHaveText(before!)
  await expect(page.getByTestId('subscriptions')).toContainText('Priority support')

  await page.getByLabel('Contact name').fill('Eve Example')
  await page.getByLabel('Contact email').fill('eve@example.com')
  await page.getByRole('button', { name: 'Add contact' }).click()
  await expect(page.getByTestId('contacts')).toContainText('Eve Example')

  const tag = page.getByTestId('tags').getByRole('button', { name: 'strategic' })
  const pressed = await tag.getAttribute('aria-pressed')
  await tag.click()
  await expect(tag).toHaveAttribute('aria-pressed', pressed === 'true' ? 'false' : 'true')
})

test('billing page shows rollups and runs the MRR job', async ({ page }) => {
  await page.goto('/billing')
  await expect(page.getByTestId('billing-mrr')).toContainText('$')
  await expect(page.getByTestId('payments-table').getByTestId('row')).toHaveCount(10)
  await page.getByRole('button', { name: 'Rebuild MRR rollup' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'rebuild-mrr done' })).toBeVisible()
})

test('team: roles matrix and team membership', async ({ page }) => {
  await page.goto('/team')
  await page.getByRole('radio', { name: 'Roles' }).click()
  await expect(page.getByTestId('roles-matrix')).toContainText('audit:read')
  await page.getByRole('radio', { name: 'Teams' }).click()
  const team = page.getByTestId('teams').locator('section').filter({ hasText: 'Support' })
  await team.getByLabel('Add member to Support').selectOption({ label: 'Grace Hopper' })
  const chip = team.getByRole('listitem').filter({ hasText: 'Grace Hopper' })
  await expect(chip).toHaveCount(1)
  await team.getByLabel('Remove Grace Hopper from Support').click()
  await expect(chip).toHaveCount(0)
})

test('notifications: mark all read', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('unread-count')).toBeVisible()
  await page.getByRole('button', { name: /Notifications/ }).click()
  await page.getByRole('button', { name: 'Mark all read' }).click()
  await expect(page.getByTestId('unread-count')).toHaveCount(0)
})
