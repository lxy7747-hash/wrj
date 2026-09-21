import { defineConfig } from '@playwright/test'
import isolated from './playwright.archives.config'

// 每个视口独立临时业务库与后端，不占用正式 4173 或复用正式账号。
export default defineConfig({ ...isolated, testMatch: 'system-backup.spec.ts' })
