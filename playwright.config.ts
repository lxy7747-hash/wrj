import { defineConfig, devices } from '@playwright/test'

// 两种验收视口。测试始终使用纯 Mock 入口，避免读取 .env.local 中的真实日志。
// 不复用 4173 上可能启用了真实数据的服务；测试前须关闭该端口的开发服务。
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
      command: 'npm run validate:contracts && node --import tsx server/index.ts',
      // GET /api/v1/auth/permissions without a role answers 403, which proves the server is up.
      url: 'http://127.0.0.1:4173/api/v1/auth/permissions',
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev:ui',
      url: 'http://127.0.0.1:5173',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
})
