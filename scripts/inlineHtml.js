/**
 * @description 把构建产物中的脚本与样式内联进 HTML，使配置页面成为单个文件
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function inlineHtmlPlugin() {
  return {
    name: 'blth-inline-html',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlFile = Object.values(bundle).find(
        (file) => file.type === 'asset' && file.fileName.endsWith('.html'),
      )

      if (!htmlFile) {
        return
      }

      let html = String(htmlFile.source)

      for (const [fileName, file] of Object.entries(bundle)) {
        if (file.type === 'chunk' && fileName.endsWith('.js')) {
          const pattern = new RegExp(`<script[^>]*src="[^"]*${escapeRegExp(fileName)}"[^>]*></script>`)
          const code = file.code.replace(/<\/script>/g, '<\\/script>')
          // 替换值必须是函数：字符串形式的替换值里 `$&`、`` $` ``、`$'` 会被二次展开，
          // 而压缩后的代码里几乎必然含这些序列，会撑破内联后的脚本标签
          html = html.replace(pattern, () => `<script type="module">${code}</script>`)
          delete bundle[fileName]
        } else if (file.type === 'asset' && fileName.endsWith('.css')) {
          const pattern = new RegExp(`<link[^>]*href="[^"]*${escapeRegExp(fileName)}"[^>]*>`)
          const style = String(file.source).replace(/<\/style>/g, '<\\/style>')
          html = html.replace(pattern, () => `<style>${style}</style>`)
          delete bundle[fileName]
        }
      }

      htmlFile.source = html
    },
  }
}
