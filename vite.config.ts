import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const loopbackHost = '127.0.0.1'
const uiPort = 5173

export default defineConfig({
  plugins: [vue()],
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
