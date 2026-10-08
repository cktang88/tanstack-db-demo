import { defineConfig, devices } from '@playwright/test'

const API_PORT = 3101
const WEB_PORT = 4173

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1, // tests share one SQLite database
  // no retries: a retry re-runs against data the failed attempt already changed and hides real races
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    launchOptions:
      process.env.CHROME_PATH || !process.env.CI
        ? { executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium' }
        : {},
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, storageState: 'e2e/.auth/owner.json' },
    },
  ],
  webServer: [
    {
      command: `tsx server/index.ts`,
      env: { PORT: String(API_PORT), DB_FILE: 'data/e2e.db', RESEED: '1', API_LATENCY_MS: '120' },
      url: `http://localhost:${API_PORT}/api/dev/chaos`,
      reuseExistingServer: false,
    },
    {
      command: `vp build && vp preview --port ${WEB_PORT} --strictPort`,
      env: { API_URL: `http://localhost:${API_PORT}` },
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
