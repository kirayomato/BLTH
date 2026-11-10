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
`console/console.py` 是它的 Web 控制台，用 Python 标准库实现，作为常驻 supervisor 拉起任务进程。

它复用 `src/` 下的同一套代码：构建时把 `$` 别名指向 `standalone/node-gm.ts`，并在入口最先执行
`standalone/polyfill.ts` 补齐 `window` / `document` / `navigator` / `cookieStore`。
因此 `src/` 中任务与接口相关的代码无需为两个运行环境分别维护。

运行前需要准备：

- `cookie.txt`：浏览器访问 bilibili.com 时的 cookie，兼容请求头式、Netscape 式与 JSON 三种写法
- `data/storage.json`：首次运行自动生成

```sh
python console/console.py                              # 启动控制台并拉起任务进程
node dist-standalone/blth-standalone.mjs               # 只跑任务进程，不带配置页面
BLTH_PROBE=1 node dist-standalone/blth-standalone.mjs  # 仅检查登录态，发一次请求后退出
```

控制台只监听回环地址（`http://127.0.0.1:8787`），提供完整配置页面：任务开关、配置 JSON、
日志等级、运行日志、手动点赞与【重新启动任务】按钮。页面来自 `dist-web/index.html`
（`build-web` 产物）；文件缺失时控制台给出一个精简页，仍能看日志和重启。任务进程本身不监听端口。

需要碰到任务进程内状态的接口（`/api/tasks`、`/api/modules`、`/api/config`、`/api/like`）
由控制台经 **stdin/stdout 单行 JSON 控制通道** 转发给子进程：控制台从 stdin 写请求，
任务进程把响应写成 stdout 上带 `\u001eBLTHCTL` 前缀的单行 JSON，其余行按普通日志处理。
控制台按请求 id 匹配挂起请求，重启时会把挂起请求立刻作废，避免旧进程的响应串到新进程。
`/api/status`、`/api/logs`、`/api/restart` 与静态页由控制台自己处理。

**`data/storage.json` 的唯一写入方是任务进程**：store 的防抖 watch 落 `modules`，
日志等级也由它写入。控制台从不写这个文件，因此不存在两边并发覆盖，也不需要「等旧进程
退出再合并配置」这类补偿。开关与配置 JSON 的改动在任务进程内就地覆盖 `moduleConfig`，
立即生效；重启额外提供一次「停止全部任务、按磁盘上的配置从头跑」的机会。

重新启动（`POST /api/restart`）：先停掉旧任务进程（在途请求一并中断），等它走完 600 ms 的
落盘宽限后拉起新进程。新进程重读 `data/storage.json` 与 `cookie.txt`，全部任务从头运行。
日志等级取文件中保存的值，`BLTH_LOG_LEVEL` 只是没有保存值时的缺省。
因为是一次进程替换，不需要软停开关、等检查点、恢复配置这类进程内交接；控制台始终在线，
页面不会断连。今天已完成的任务仍由模块自己的完成标记挡住，不会重复扣币或兑换。
连点会返回 409，不会叠加出多份进程；重启窗口内配置类接口返回 503。

Windows 下控制台用 Ctrl+Break 通知任务进程退出，POSIX 下用 SIGTERM；两者都走
`main.ts` 的 shutdown 留出落盘时间，超时 3 秒后强制结束。`storage.json` 采用临时文件改名写入，
强杀也不会留下半截文件。

运行日志：任务进程的 stdout / stderr 由控制台按行捕获，只存在控制台进程内存，保留最近 1000 条，
不写文件。`seq` 全局递增，重启任务进程不清空、不换会话标识，页面增量拉取到的日志保持连续；
只有控制台自身重启才会换会话标识，页面据此清空重取。日志等级由 `BLTH_LOG_LEVEL` 决定，
它同时控制终端输出与页面能记录到的内容。warn / error 走 stderr，控制台按文本区分两者。

配置 JSON：`data/storage.json` 里的 `modules` 子树由任务进程的 store 防抖 watch 落盘；
控制台改配置时必须先停任务进程再写，避免两边并发覆盖。`cache`/`ui`/`logLevel` 不在编辑范围内。

构建分两步：`vite.web.config.ts` 先构建 `standalone/web` 得到内联了全部脚本与样式的单个 HTML
（`dist-web/`），`vite.standalone.config.ts` 再产出 Node 可执行文件。两者由
`build-standalone` 按序串联；Node 产物不再内嵌该 HTML，它由控制台直接提供。

可用环境变量：`BLTH_COOKIE_FILE`、`BLTH_DATA_DIR`、`BLTH_UA`、`BLTH_WATCHDOG_INTERVAL`、
`BLTH_LOG_LEVEL`（均由控制台透传给任务进程）；`BLTH_CONFIG_PORT` 由控制台自己使用。
控制台另支持 `--node`、`--script`、`--web`、`--port` 参数。

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
- `dist-web/index.html` 由 `build-web` 产出，供配置页面使用；Node 产物不再引用它，单独执行 `build-standalone-node` 不需要它
- 控制通道的行前缀 `\u001eBLTHCTL` 在 `standalone/control.ts` 与 `console/console.py` 各写了一份，改动必须同步，否则控制响应会被当成日志、配置类接口全部超时
- 日志等级为 `none` 时 `polyfill.ts` 会屏蔽所有 `console` 输出，控制响应必须用 `process.stdout.write` 直写，不能走 `console`
- 向 HTML 内联压缩后的 JS 时，`String.replace` 的替换值必须用函数形式：字符串替换值中的 `$&`、`` $` ``、`$'` 会被二次展开，而压缩代码里几乎必然含这些序列，会把 script 标签撑破（`scripts/inlineHtml.js` 曾因此产出多个 `</script>`，页面整页乱码）
