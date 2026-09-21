import { defineConfig } from '@playwright/test'
import isolated from './playwright.archives.config'

// 五模块联调只使用各用例的临时数据及后端，不占用正式 4173/5173。
export default defineConfig({
  ...isolated,
  testMatch: ['local-archives.spec.ts', 'master-data.spec.ts', 'runtime-health.spec.ts', 'system-backup.spec.ts'],
  outputDir: 'output/playwright/management-acceptance',
  reporter: [['list'], ['json', { outputFile: 'output/playwright/management-acceptance.json' }]],
})
