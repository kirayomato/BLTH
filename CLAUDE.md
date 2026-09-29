# 项目概述

BLTH（Bilibili Live Tasks Helper）是基于 Vue 3 + Vite + vite-plugin-monkey + Element Plus + TypeScript 的用户脚本（Userscript），通过用户脚本管理器（Tampermonkey/Violentmonkey）运行在 Bilibili 直播页面（`https://live.bilibili.com/直播间号`），实现自动完成每日任务、观看体验优化和页面元素清理。

# 常用命令

```sh
npm run dev                # 启动 Vite 开发服务器并安装脚本（支持 HMR）
npm run build              # 类型检查 + 用户脚本构建 + 独立运行版构建
npm run build-minify       # 仅构建用户脚本（含压缩）
npm run build-standalone   # 仅构建独立运行版
npm run type-check         # 用户脚本与独立运行版的类型检查
npm run lint               # ESLint + Stylelint 自动修复
npm run format             # 使用 Prettier 格式化 src/
npm run preview            # 打开提供编译产物安装链接的本地预览网页
```

无自动化测试。

# 独立运行版

`standalone/` 是不依赖浏览器的版本，只包含每日任务，产物为 `dist-standalone/blth-standalone.mjs`。

它复用 `src/` 下的同一套代码：构建时把 `$` 别名指向 `standalone/node-gm.ts`，并在入口最先执行
`standalone/polyfill.ts` 补齐 `window` / `document` / `navigator` / `cookieStore`。
因此 `src/` 中任务与接口相关的代码无需为两个运行环境分别维护。

运行前需要准备：

- `cookie.txt`：浏览器访问 bilibili.com 时的 cookie，兼容请求头式、Netscape 式与 JSON 三种写法
- `data/storage.json`：首次运行自动生成

```sh
node dist-standalone/blth-standalone.mjs                # 常驻运行
BLTH_PROBE=1 node dist-standalone/blth-standalone.mjs   # 仅检查登录态，发一次请求后退出
```

启动后访问 `http://127.0.0.1:8787` 打开配置页面，可以开关各项任务，也能在下拉框里调整日志等级
（debug / info / warn / error / 关闭），改动即时生效并落盘；任务参数（投币数量、
观看时长、弹幕列表、房间名单）仍需直接编辑 `data/storage.json`。页面只监听回环地址。

构建分两步：`vite.web.config.ts` 先构建 `standalone/web` 得到内联了全部脚本与样式的单个 HTML
（`dist-web/`），`vite.standalone.config.ts` 再把该 HTML 嵌进可执行文件。两者由
`build-standalone` 按序串联。

可用环境变量：`BLTH_COOKIE_FILE`、`BLTH_DATA_DIR`、`BLTH_UA`、`BLTH_WATCHDOG_INTERVAL`、
`BLTH_CONFIG_PORT`、`BLTH_NO_CONFIG_PAGE`、`BLTH_LOG_LEVEL`（日志等级默认值，配置页面的选择
会覆盖它并持久化到 `data/storage.json`，重启后仍以页面保存的值为准）。

两版共用任务逻辑，但完成状态各自独立存储，**不要同时运行**，否则任务会被重复执行。

# 架构

## 模块系统

所有模块继承 `src/modules/BaseModule.ts`，由 `src/stores/useModuleStore.ts` 管理生命周期。

模块分两类：

- **默认模块**（`src/modules/default/`）：做准备工作，如基础数据获取，先于大多数功能模块加载
- **功能模块**：实现具体业务逻辑，如完成每日任务

## 配置持久化

`src/library/storage/` 通过 `GM_setValue`/`GM_getValue` 存取配置。
用户脚本下这两个 API 由脚本管理器提供；独立运行版下由 `standalone/node-gm.ts` 实现，后端是 JSON 文件。

## 多标签页安全

脚本分三类：`Main`，`SubMain`，`Other`。同时打开多个直播间页面时，`src/stores/useCacheStore.ts` 会选出唯一 `Main` 脚本，避免部分模块重复加载。

# 分支

- `master`：发布分支。合并来自 `dev` 的 PR 后触发 GitHub Actions 自动构建并创建 Release
- `dev`：开发分支。非发布 PR 的目标分支

# 规范

- `src/library/bili-api/` 中的 API 必须有详细的请求/响应类型定义
- 路径别名 `@/` 映射到 `src/`
- Commit message 使用约定式提交格式

# 易踩坑点

- 新增第三方库须写进 `vite.config.ts` 的 `externalGlobals`/`externalResource` 中，通过 `@require`/`@resource` 引入，不打包进脚本
- 调试早期模块（`runAt = 'document-start'`）时 dev 模式注入太晚，请用 `npm run build` 的产物测试
- `src/modules/dailyTasks/` 下的模块被用户脚本与独立运行版共用，不要依赖真实 DOM 结构或页面上才有的对象（如 `window.BilibiliLive`、`window.livePlayer`），否则独立运行版无法运行
- 独立运行版需要 Node API 时，不要给 `tsconfig.standalone.json` 加 `@types/node`：它的全局声明会把 `setTimeout` 的返回类型换成 `NodeJS.Timeout`，与 `BaseModule.nextRunTimer` 的 `number` 冲突；改在 `standalone/node-shim.d.ts` 里按需声明
- `dist-web` 必须先于独立运行版存在（`build-standalone` 已按序串联），单独执行 `build-standalone-node` 会因缺少 `dist-web/index.html` 而失败
- 向 HTML 内联压缩后的 JS 时，`String.replace` 的替换值必须用函数形式：字符串替换值中的 `$&`、`` $` ``、`$'` 会被二次展开，而压缩代码里几乎必然含这些序列，会把 script 标签撑破（`scripts/inlineHtml.js` 曾因此产出多个 `</script>`，页面整页乱码）
