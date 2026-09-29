import { cookieHeader } from './cookie'
import { storage } from './storage'

/**
 * 共享源码通过 `import { ... } from '$'` 访问油猴 API，`$` 是 vite-plugin-monkey
 * 提供的虚拟模块。独立运行版在构建时把 `$` 指向本文件，从而无需改动任何共享源码。
 */

export const unsafeWindow = globalThis as any

export function GM_getValue<T>(key: string, defaultValue?: T): T {
  return storage.get(key, defaultValue as T)
}

export function GM_setValue(key: string, value: any): void {
  storage.set(key, value)
}

export function GM_deleteValue(key: string): void {
  storage.delete(key)
}

export function GM_listValues(): string[] {
  return storage.keys()
}

/**
 * 独立运行版没有页面可注入样式，保留空实现以免共享模块在导入时出错。
 */
export function GM_addStyle(_css: string): null {
  return null
}

export function GM_registerMenuCommand(): void {}

export function GM_notification(): void {}

export function GM_log(...args: unknown[]): void {
  console.log(...args)
}

interface GmRequestDetails {
  method?: string
  url: string
  headers?: Record<string, string>
  data?: any
  responseType?: string
  timeout?: number
  onload?: (response: GmResponse) => void
  onerror?: (error: unknown) => void
  ontimeout?: () => void
}

interface GmResponse {
  finalUrl: string
  readyState: number
  status: number
  statusText: string
  responseHeaders: string
  response: unknown
  responseText: string
}

/**
 * GM_xmlhttpRequest 的 Node 实现。
 *
 * 共享代码依赖 onload / onerror 两个回调以及 responseType === 'json' 时
 * 直接给出已解析对象的行为，其余字段仅为兼容签名。
 */
export function GM_xmlhttpRequest(details: GmRequestDetails): void {
  const method = (details.method ?? 'GET').toUpperCase()
  const sendBody = method !== 'GET' && method !== 'HEAD' && details.data != null
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  if (details.timeout) {
    timer = setTimeout(() => controller.abort(), details.timeout)
  }

  fetch(details.url, {
    method,
    // 浏览器里的 GM_xmlhttpRequest 会自动带上目标域名的 cookie，Node 的 fetch 不会
    headers: { Cookie: cookieHeader(), ...details.headers },
    body: sendBody ? details.data : undefined,
    signal: controller.signal,
  })
    .then(async (response) => {
      const responseText = await response.text()

      let parsed: unknown = responseText
      if (details.responseType === 'json') {
        try {
          parsed = JSON.parse(responseText)
        } catch {
          parsed = null
        }
      }

      details.onload?.({
        finalUrl: response.url,
        readyState: 4,
        status: response.status,
        statusText: response.statusText,
        responseHeaders: Array.from(response.headers.entries())
          .map(([name, value]) => `${name}: ${value}`)
          .join('\r\n'),
        response: parsed,
        responseText,
      })
    })
    .catch((error: Error) => {
      if (error.name === 'AbortError') {
        details.ontimeout?.()
      } else {
        details.onerror?.({ error: error.message, message: error.message })
      }
    })
    .finally(() => {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    })
}
