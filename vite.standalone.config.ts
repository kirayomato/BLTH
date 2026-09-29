import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'

/**
 * 独立运行版的构建配置。
 *
 * 与用户脚本版本的配置刻意分开：monkey 插件负责注入油猴元数据并接管 `$` 虚拟模块，
 * 而独立运行版需要把 `$` 换成 Node 实现，两者无法共存于同一次构建。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      $: fileURLToPath(new URL('./standalone/node-gm.ts', import.meta.url)),
    },
  },
  build: {
    target: 'node20',
    outDir: 'dist-standalone',
    emptyOutDir: true,
    // 保留可读的调用栈，便于排查运行时问题
    minify: false,
    // 不生成 sourcemap，产物单文件便于直接分发
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL('./standalone/main.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'blth-standalone.mjs',
    },
    rollupOptions: {
      // Node 内置模块不打进产物
      external: [/^node:/],
    },
  },
})
