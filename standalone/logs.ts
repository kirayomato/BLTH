/** 可记录的日志等级；none 不产生任何记录，故不在此列 */
export type ConsoleLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  /** 进程内单调递增，页面据此拉取增量 */
  seq: number
  /** 记录时刻的毫秒时间戳 */
  time: number
  level: ConsoleLogLevel
  /** Logger 前缀中的模块名，形如 [DailyTask][LiveTask]；普通 console 调用为空 */
  title: string
  text: string
}

/** 页面可拉取的记录上限，超出后丢弃最旧的 */
const MAX_RECORDS = 1000

/**
 * 进程标识。
 *
 * 页面按 seq 增量拉取，而重启后 seq 会从头开始，沿旧序号拉取永远拿不到新记录；
 * 会话标识一旦变化，页面就知道该清空重取。
 */
export const logSession = Math.random().toString(36).slice(2, 10)

const records: LogRecord[] = []

let nextSeq = 1

/**
 * 记录一条控制台输出。
 *
 * 调用方已按当前等级过滤，因此这里不再判断等级：页面与终端看到的内容一致。
 */
export function appendConsoleLog(level: ConsoleLogLevel, args: unknown[]): void {
  const { title, text } = splitArgs(args)
  const record: LogRecord = { seq: nextSeq++, time: Date.now(), level, title, text }

  records.push(record)
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS)
  }
}

/** 取出 seq 之后的记录；after 为 0 时返回整个缓冲 */
export function getLogRecords(after = 0): LogRecord[] {
  return after > 0 ? records.filter((record) => record.seq > after) : records.slice()
}

/**
 * Logger 的前缀形如 `BLTH[2026/11/6 16:00:00][DailyTask][LiveTask]:`（%c 已去掉）。
 *
 * 时间之后的部分是模块名，层级用相邻的方括号表示，这里整段取出来作为筛选键。
 */
const LOGGER_PREFIX = /^BLTH\[[^\]]*\]((?:\[[^\]]*\])*):$/

function splitArgs(args: unknown[]): { title: string; text: string } {
  const first = typeof args[0] === 'string' ? args[0] : ''
  const prefix = LOGGER_PREFIX.exec(first)

  const body = (prefix ? args.slice(1) : args).map(stringify).filter((part) => part !== '')

  return { title: prefix ? prefix[1] : '', text: body.join(' ') }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`
  }

  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      // 循环引用等无法序列化的情况，退回默认字符串形式
    }
  }

  return String(value)
}
