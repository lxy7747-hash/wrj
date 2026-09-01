import { defineConfig, devices } from '@playwright/test'

// Two fixed viewports per the baseline acceptance rule: 1920×1080 primary, 1366×768 secondary.
// The webServer array boots the deterministic loopback mock and the Vite UI on their canonical
// ports; both are reused when already running locally.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: 1,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-1920x1080',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } },
    },
    {
      name: 'chromium-1366x768',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
  ],
  webServer: [
    {
      command: 'npm run dev:mock',
      // GET /api/v1/auth/permissions without a role answers 403, which proves the server is up.
      url: 'http://127.0.0.1:4173/api/v1/auth/permissions',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run dev:ui',
      url: 'http://127.0.0.1:5173',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
})
