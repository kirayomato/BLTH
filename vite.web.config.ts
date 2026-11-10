import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { inlineHtmlPlugin } from './scripts/inlineHtml.js'

/**
 * 独立运行版配置页面的构建配置。
 *
 * 产物是单个内联了全部脚本与样式的 HTML，由 Python 控制台直接读取并提供服务。
 * 内联是为了让控制台只处理一个文件，不必做静态资源目录映射。
 */
export default defineConfig({
  // 以页面目录为根，产物才会直接落在 dist-web/index.html
  root: fileURLToPath(new URL('./standalone/web', import.meta.url)),
  plugins: [vue(), inlineHtmlPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'esnext',
    outDir: fileURLToPath(new URL('./dist-web', import.meta.url)),
    emptyOutDir: true,
    // 样式全部内联，无需单独的文件，也不需要拆包
    cssCodeSplit: false,
  },
})
