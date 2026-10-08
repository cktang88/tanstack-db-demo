import { test as setup } from '@playwright/test'

// Sign in once per role and save the session cookie for the test projects.
for (const role of ['owner', 'member', 'viewer', 'billing'] as const) {
  setup(`authenticate as ${role}`, async ({ request }) => {
    const res = await request.post('/api/auth/login', { data: { email: `${role}@saasly.dev`, password: 'password' } })
    if (!res.ok()) throw new Error(`login failed for ${role}: ${res.status()}`)
    await request.storageState({ path: `e2e/.auth/${role}.json` })
  })
}
