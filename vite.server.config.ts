import { defineConfig } from 'vite'

// 独立打包后端及其源码/JSON 依赖；运行时只需生产 npm 依赖，不依赖 tsx 或源码目录。
export default defineConfig({
  build: {
    ssr: 'server/lan.ts',
    outDir: 'server-dist',
    emptyOutDir: true,
    target: 'node22',
    rolldownOptions: { output: { entryFileNames: 'server.mjs', chunkFileNames: '[name]-[hash].mjs' } },
  },
})
