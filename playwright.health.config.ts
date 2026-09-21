import { defineConfig } from '@playwright/test'
import isolated from './playwright.archives.config'

// 复用双视口及独立 5175 预览；监测用例自行管理临时服务和数据库。
export default defineConfig({ ...isolated, testMatch: 'runtime-health.spec.ts' })
