import { resolve } from 'node:path'

export interface StandaloneOptions {
  /** 数据目录，存放 storage.json */
  dataDir: string
  /** cookie 文本所在文件 */
  cookieFile: string
  /** 请求时使用的浏览器 UA，参与直播心跳签名 */
  userAgent: string
  /** 失效看门狗的扫描间隔（毫秒） */
  watchdogInterval: number
}

/**
 * 默认 UA。
 *
 * 直播心跳会把 navigator.userAgent 作为签名字段之一，Node 自身的
 * `Node.js/x.y.z` 会显得异常，因此这里固定为一个常见的桌面浏览器 UA。
 */
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

function readEnv(name: string): string | undefined {
  const value = process.env[name]
  return value && value.trim() ? value.trim() : undefined
}

export const options: StandaloneOptions = {
  dataDir: resolve(readEnv('BLTH_DATA_DIR') ?? 'data'),
  cookieFile: resolve(readEnv('BLTH_COOKIE_FILE') ?? 'cookie.txt'),
  userAgent: readEnv('BLTH_UA') ?? DEFAULT_USER_AGENT,
  watchdogInterval: Number(readEnv('BLTH_WATCHDOG_INTERVAL') ?? 300_000),
}
