import { defineConfig, devices } from '@playwright/test'

// 隔离 E2E 配置：默认 4173/5173 常被既有 dev/mock 实例占用，这里改用独立端口，
// 起一个全新代码的 mock 服务（server/index.ts，读 MOCK_PORT）与独立 vite（VITE_MOCK_ORIGIN 指向 mock）。
// report-filter / report-evidence 用例用 page.route 把 /api 转发到用例内进程内服务，二者互不污染。
const uiPort = Number(process.env.E2E_UI_PORT ?? 5180)
const mockPort = Number(process.env.E2E_MOCK_PORT ?? 4273)
const uiOrigin = `http://127.0.0.1:${uiPort}`
const mockOrigin = `http://127.0.0.1:${mockPort}`

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  timeout: 240_000,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: uiOrigin, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium-1920x1080', use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } } },
  ],
  webServer: [
    {
      command: 'node --import tsx server/index.ts',
      url: `${mockOrigin}/api/v1/auth/permissions`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { MOCK_PORT: String(mockPort) },
    },
    {
      command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${uiPort} --strictPort`,
      url: uiOrigin,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { VITE_MOCK_ORIGIN: mockOrigin },
    },
  ],
})
