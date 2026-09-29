// 该 HTML 由 vite.web.config.ts 构建产出（已内联全部脚本与样式），
// 再由 standalone 的构建内联进产物，因此运行时不需要任何外部文件。
import html from '../dist-web/index.html?raw'

export const configPageHtml = html
