import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/e2e/**'],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      thresholds: {
        statements: 90,
        lines: 90,
        functions: 95,
        branches: 90,
        'server/app.ts': {
          branches: 90,
        },
        'server/ws/realtime.ts': {
          branches: 90,
        },
        'src/stores/*.ts': {
          statements: 90,
          lines: 90,
          functions: 90,
          branches: 90,
        },
        'src/router/*.ts': {
          statements: 90,
          lines: 90,
          functions: 90,
          branches: 90,
        },
      },
    },
  },
})
