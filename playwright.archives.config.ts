import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// 归档用例自行启动临时 SQLite/纯 Mock，不占用正式后端或读取本机账号库。
export default defineConfig({
  ...base,
  testMatch: 'local-archives.spec.ts',
  use: { ...base.use, baseURL: 'http://127.0.0.1:5175' },
  webServer: [{
    command: 'npm run build && npx vite preview --host 127.0.0.1 --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175',
    timeout: 120_000,
    reuseExistingServer: false,
  }],
})
