import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import App from './App.vue'

// Element Plus 的样式由 index.html 里的 CDN <link> 提供，此处不再 import，
// 避免把 element-plus/dist/index.css 打进产物。
createApp(App).use(ElementPlus).mount('#app')
