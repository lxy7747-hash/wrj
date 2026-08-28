import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createVersaTilesPlugin } from './scripts/vite-versatiles-plugin.ts'

const loopbackHost = '127.0.0.1'
const uiPort = 5173

export default defineConfig({
  plugins: [vue(), createVersaTilesPlugin()],
  server: {
    host: loopbackHost,
    port: uiPort,
    strictPort: true,
  },
  preview: {
    host: loopbackHost,
    port: uiPort,
    strictPort: true,
  },
})
