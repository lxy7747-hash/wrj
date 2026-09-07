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
  optimizeDeps: {
    // 自动组件插件在懒路由转换时才注入样式，预构建可避免首次导航触发依赖重优化和整页重载。
    include: [
      'element-plus/es',
      // 与当前模板及消息 API 使用的组件保持一致；新增组件时同步样式入口。
      ...[
        'alert', 'base', 'button', 'card', 'collapse', 'collapse-item', 'container',
        'date-picker', 'descriptions', 'descriptions-item', 'dialog', 'drawer', 'empty',
        'form', 'form-item', 'input', 'input-number', 'loading', 'main', 'menu',
        'menu-item', 'menu-item-group', 'message', 'message-box', 'option', 'option-group',
        'popconfirm', 'progress', 'radio-button', 'radio-group', 'result', 'select',
        'skeleton', 'slider', 'step', 'steps', 'switch', 'tab-pane', 'table',
        'table-column', 'tabs', 'tag', 'tooltip',
      ].map((component) => `element-plus/es/components/${component}/style/css`),
    ],
  },
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
