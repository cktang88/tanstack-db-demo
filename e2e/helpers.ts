import { expect, type Browser, type Page, type PlaywrightWorkerArgs } from '@playwright/test'

export type Role = 'owner' | 'admin' | 'billing' | 'member' | 'viewer'

/** A page signed in as `role` (sessions are created by auth.setup.ts). */
export async function pageAs(browser: Browser, role: Role): Promise<Page> {
  const ctx = await browser.newContext({ storageState: `e2e/.auth/${role}.json`, viewport: { width: 1440, height: 900 } })
  return ctx.newPage()
}

/** Reseed the shared demo database so every spec starts from the same data, whatever ran before it. */
export async function resetDemo(playwright: PlaywrightWorkerArgs['playwright'], baseURL: string | undefined) {
  const owner = await playwright.request.newContext({ baseURL, storageState: 'e2e/.auth/owner.json' })
  expect((await owner.post('/api/dev/reset', { data: {} })).ok()).toBe(true)
  await owner.put('/api/dev/chaos', { data: { latencyMs: 120, failRate: 0 } })
  await owner.dispose()
}

/** The unread badge must show exactly what the API says the *current* user has. */
export async function expectUnreadBadgeMatchesApi(page: Page) {
  const res = await page.request.get('/api/notifications?readAt[isNull]&limit=0')
  expect(res.ok()).toBe(true)
  const { total } = (await res.json()) as { total: number }
  await expect(page.getByRole('button', { name: /^Notifications \(/ })).toHaveAccessibleName(`Notifications (${total} unread)`)
}
