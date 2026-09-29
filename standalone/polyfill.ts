import { options, getLogLevel } from './config'
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

const cookies = loadCookiesOrExit()

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
      async getAll() {
        return Object.entries(cookies).map(([name, value]) => entry(name, value))
      },
      async get(name: string) {
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
 * Node 的 console 不支持 %c，共享代码的日志前缀会把整段样式声明原样打出来，这里过滤掉。
 */
function installConsoleFilter(): void {
  const isStyleRule = (value: unknown): boolean =>
    typeof value === 'string' && /^\s*(font-|color:|background|padding:|border-radius)/.test(value)

  // 等级数值越小越详细；none 为最高，会屏蔽一切输出
  const levelRank: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3, none: 4 }
  const methodRank: Record<string, number> = { debug: 0, log: 1, warn: 2, error: 3 }

  for (const method of ['log', 'debug', 'warn', 'error'] as const) {
    const original = console[method].bind(console)

    console[method] = (...args: unknown[]) => {
      // 低于当前等级的日志直接丢弃，实现日志等级开关
      const threshold = levelRank[getLogLevel()] ?? 1
      if (methodRank[method] < threshold) {
        return
      }

      original(
        ...args
          .filter((arg) => !isStyleRule(arg))
          .map((arg) => (typeof arg === 'string' ? arg.replace(/%c/g, '') : arg)),
      )
    }
  }
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
