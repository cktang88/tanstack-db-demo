import type { Browser, Page } from '@playwright/test'

export type Role = 'owner' | 'admin' | 'billing' | 'member' | 'viewer'

/** A page signed in as `role` (sessions are created by auth.setup.ts). */
export async function pageAs(browser: Browser, role: Role): Promise<Page> {
  const ctx = await browser.newContext({ storageState: `e2e/.auth/${role}.json`, viewport: { width: 1440, height: 900 } })
  return ctx.newPage()
}
