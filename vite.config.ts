import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { createVersaTilesPlugin } from './scripts/vite-versatiles-plugin.ts'

const loopbackHost = '127.0.0.1'
const uiPort = 5173

export default defineConfig({
  plugins: [
    vue(),
    AutoImport({ resolvers: [ElementPlusResolver()], dts: false }),
    Components({ resolvers: [ElementPlusResolver()], dts: false }),
    createVersaTilesPlugin(),
  ],
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
