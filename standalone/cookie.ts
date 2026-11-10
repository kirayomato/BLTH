import { existsSync, readFileSync } from 'node:fs'
import { options } from './config'

/**
 * 解析 cookie 文本。
 *
 * 兼容三种常见写法：
 * 1. 请求头式：`a=1; b=2`
 * 2. Netscape 式：制表符分隔的多列文本，第 6、7 列分别为 name、value
 * 3. JSON：`{"a":"1"}` 或 `[{"name":"a","value":"1"}]`
 */
export function parseCookieText(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  const content = text.trim()
  if (!content) {
    return result
  }

  if (content.startsWith('{') || content.startsWith('[')) {
    const fromJson = parseJsonCookies(content)
    if (fromJson) {
      return fromJson
    }
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    // Netscape 式：以制表符分割，name / value 位于最后两列
    const cells = rawLine.split('\t')
    if (cells.length >= 7) {
      const name = cells[5].trim()
      if (name) {
        result[name] = cells[6].trim()
      }
      continue
    }

    // 请求头式：按分号分段，每段形如 name=value
    for (const pair of line.split(';')) {
      const separator = pair.indexOf('=')
      if (separator <= 0) {
        continue
      }
      const name = pair.slice(0, separator).trim()
      if (name) {
        result[name] = pair.slice(separator + 1).trim()
      }
    }
  }

  return result
}

let cached: Record<string, string> | undefined

/**
 * 读取并缓存 cookie。
 *
 * @throws 文件缺失、无法解析或缺少必要字段时抛出
 */
export function loadCookies(): Record<string, string> {
  if (cached) {
    return cached
  }

  if (!existsSync(options.cookieFile)) {
    throw new Error(
      `未找到 cookie 文件：${options.cookieFile}\n` +
        '请将浏览器访问 bilibili.com 时的 cookie 写入该文件。',
    )
  }

  const parsed = parseCookieText(readFileSync(options.cookieFile, 'utf-8'))
  if (Object.keys(parsed).length === 0) {
    throw new Error(`cookie 文件内容无法解析：${options.cookieFile}`)
  }

  const missing = ['SESSDATA', 'bili_jct'].filter((name) => !parsed[name])
  if (missing.length > 0) {
    throw new Error(`cookie 缺少必要字段：${missing.join('、')}`)
  }

  cached = parsed
  return cached
}

/** 拼成请求头可用的 Cookie 字段值 */
export function cookieHeader(): string {
  return Object.entries(loadCookies())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

function parseJsonCookies(content: string): Record<string, string> | undefined {
  try {
    const parsed: unknown = JSON.parse(content)
    const result: Record<string, string> = {}

    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const entry = item as { name?: unknown; value?: unknown }
        if (typeof entry?.name === 'string' && entry.value != null) {
          result[entry.name] = String(entry.value)
        }
      }
      return result
    }

    if (parsed && typeof parsed === 'object') {
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value != null) {
          result[name] = String(value)
        }
      }
      return result
    }
  } catch {
    // 不是合法的 JSON，交给文本解析处理
  }

  return undefined
}
