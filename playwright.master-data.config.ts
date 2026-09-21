import { defineConfig } from '@playwright/test'
import isolated from './playwright.archives.config'

// 每个用例使用临时主数据 SQLite 和纯 Mock 后端，不接触正式数据或 4173 服务。
export default defineConfig({ ...isolated, testMatch: 'master-data.spec.ts' })
