import { expect, test } from '@playwright/test'
import { expectUnreadBadgeMatchesApi, pageAs, resetDemo } from './helpers'

test.beforeAll(({ playwright, baseURL }) => resetDemo(playwright, baseURL))

test.describe('authentication & authorization', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('redirects to login, rejects bad credentials, signs in with a demo account', async ({ page }) => {
    await page.goto('/customers')
    await expect(page).toHaveURL(/\/login/)
    await page.getByLabel('Password').fill('wrong')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Invalid email or password')
    await page.getByRole('button', { name: 'Sign in as member' }).click()
    await expect(page.getByTestId('user-menu')).toContainText('Linus Torvalds')
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/login/)
    await page.goto('/')
    await expect(page).toHaveURL(/\/login/)
  })

  test("switching users in one tab shows only the new user's data", async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: 'Sign in as member' }).click()
    await expect(page.getByTestId('user-menu')).toContainText('Linus Torvalds')
    await expectUnreadBadgeMatchesApi(page)
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL(/\/login/)
    // same tab, no reload: nothing cached for the member may show up for the viewer
    await page.getByRole('button', { name: 'Sign in as viewer' }).click()
    await expect(page.getByTestId('user-menu')).toContainText('Barbara Liskov')
    await expectUnreadBadgeMatchesApi(page)
    await page
      .getByRole('link', { name: /Settings/ })
      .first()
      .click()
    const sessions = (await (await page.request.get('/api/sessions?limit=0')).json()) as { total: number }
    await expect(page.getByTestId('sessions').getByRole('listitem')).toHaveCount(sessions.total)
  })
})

test('viewer sees a read-only app and is denied the audit log', async ({ browser }) => {
  const page = await pageAs(browser, 'viewer')
  await page.goto('/customers')
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'Audit log' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '+ New customer' })).toHaveCount(0)
  await page.getByTestId('customers-table').getByTestId('row').first().getByRole('link').first().click()
  await expect(page.getByRole('button', { name: 'Edit' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0)
  await page.goto('/audit')
  await expect(page.getByRole('alert')).toContainText('Access denied')
  await page.close()
})

test('members can edit their own accounts only', async ({ browser }) => {
  const page = await pageAs(browser, 'member')
  await page.goto('/customers?ownerId=4')
  await page.getByTestId('customers-table').getByTestId('row').first().getByRole('link').first().click()
  await expect(page.getByRole('button', { name: 'Edit' })).toBeEnabled()
  await page.goto('/customers?ownerId=1')
  await page.getByTestId('customers-table').getByTestId('row').first().getByRole('link').first().click()
  await expect(page.getByRole('button', { name: 'Edit' })).toBeDisabled()
  await expect(page.getByText(/read-only — owned by/)).toBeVisible()
  // the server enforces the same rule even if the UI is bypassed
  const res = await page.request.patch(`/api${new URL(page.url()).pathname}`, { data: { seats: 3 } })
  expect(res.status()).toBe(403)
  await page.close()
})

test('denied attempts land in the append-only audit log', async ({ browser, page }) => {
  const viewer = await pageAs(browser, 'viewer')
  expect((await viewer.request.patch('/api/customers/3', { data: { seats: 9 } })).status()).toBe(403)
  await viewer.close()
  await page.goto('/audit?action=denied')
  const row = page.getByTestId('audit-table').getByTestId('row').first()
  await expect(row).toContainText('Barbara Liskov')
  await expect(row).toContainText('PATCH /api/customers/3')
  // the API refuses to modify history
  expect((await page.request.delete('/api/audit-log/1')).status()).toBe(405)
})
