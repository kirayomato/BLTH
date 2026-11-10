import { options } from './config'
import { loadCookies } from './cookie'

/**
 * 运行环境适配层。
 *
 * 共享源码里有若干处直接访问浏览器对象：`document.querySelector`（library/dom 顶层）、
 * `window.fetch`（library/fetch-hook 顶层）、`cookieStore`（library/cookie）、
 * `navigator.userAgent`（直播心跳签名）。这里把它们补齐，使那些文件无需改动。
 */

// 时区须尽早确定：lightTask 用原生 Date 判断执行时段，而项目其余时间判断统一为东八区
if (!process.env.TZ) {
  process.env.TZ = 'Asia/Shanghai'
}

// 启动时先校验一次 cookie 文件，缺失或格式错误直接退出
loadCookiesOrExit()

installWindow()
installDocument()
installNavigator()
installCookieStore()
installConsoleFilter()

function loadCookiesOrExit(): Record<string, string> {
  try {
    return loadCookies()
  } catch (error) {
    console.error(`[BLTH] 启动失败：${(error as Error).message}`)
    process.exit(1)
  }
}

function installWindow(): void {
  const scope = globalThis as any

  if (!scope.window) {
    scope.window = globalThis
  }

  // Node 的全局对象没有事件接口，共享代码里的 window.addEventListener 需要能被安全调用
  if (typeof scope.addEventListener !== 'function') {
    scope.addEventListener = () => {}
    scope.removeEventListener = () => {}
  }
}

function installDocument(): void {
  const scope = globalThis as any

  if (!scope.document) {
    scope.document = {
      readyState: 'complete',
      head: createElementStub('head'),
      body: createElementStub('body'),
      documentElement: createElementStub('html'),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: createElementStub,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
    }
  }
}

function installNavigator(): void {
  // 心跳签名会带上 UA，Node 自身的 `Node.js/x.y.z` 容易被判定为异常客户端
  const navigator = { userAgent: options.userAgent, language: 'zh-CN', platform: 'Win32' }

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: navigator,
      configurable: true,
      writable: true,
    })
  } catch {
    console.warn('[BLTH] 无法覆盖 navigator，直播心跳将使用运行时默认 UA')
  }
}

function installCookieStore(): void {
  const entry = (name: string, value: string) => ({
    name,
    value,
    domain: '.bilibili.com',
    path: '/',
  })

  Object.defineProperty(globalThis, 'cookieStore', {
    value: {
      // 每次取用都走 loadCookies：它自己带缓存，进程重启后自然读到新 cookie
      async getAll() {
        return Object.entries(loadCookies()).map(([name, value]) => entry(name, value))
      },
      async get(name: string) {
        const cookies = loadCookies()
        return Object.prototype.hasOwnProperty.call(cookies, name)
          ? entry(name, cookies[name])
          : undefined
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    configurable: true,
    writable: true,
  })
}

/**
 * 日志等级标记，必须与 console/console.py 的 LEVEL_MARK 保持一致。
 *
 * 用 ASCII 记录分隔符包裹，终端里不占可见宽度；控制台解析后从正文中剥掉。
 */
const LOG_LEVEL_MARK = '\x1eBLTHLVL:'
const LOG_LEVEL_END = '\x1e'

/**
 * Node 的 console 不支持 %c，共享代码的日志前缀会把整段样式声明原样打出来，这里过滤掉。
 *
 * 不按等级屏蔽：全部级别的输出都保留，等级只用于页面上的显示筛选。为了让筛选准确，
 * 每行前面带一个记录分隔符包裹的等级标记，控制台读取后据此归档并从正文里剥掉。
 */
function installConsoleFilter(): void {
  const methodLevel = { log: 'info', debug: 'debug', warn: 'warn', error: 'error' } as const

  for (const method of ['log', 'debug', 'warn', 'error'] as const) {
    const original = console[method].bind(console)

    console[method] = (...args: unknown[]) => {
      original(`${LOG_LEVEL_MARK}${methodLevel[method]}${LOG_LEVEL_END}`, ...formatConsoleArgs(args))
    }
  }
}

function isStyleRule(value: unknown): boolean {
  return (
    typeof value === 'string' && /^\s*(font-|color:|background|padding:|border-radius)/.test(value)
  )
}

function formatConsoleArgs(args: unknown[]): unknown[] {
  return args
    .filter((arg) => !isStyleRule(arg))
    .map((arg) => (typeof arg === 'string' ? arg.replace(/%c/g, '') : arg))
}

function createElementStub(tagName: string): any {
  return {
    tagName: tagName.toUpperCase(),
    id: '',
    className: '',
    innerHTML: '',
    textContent: '',
    style: {},
    classList: {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false,
    },
    append: () => {},
    appendChild: () => {},
    remove: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
  }
}
