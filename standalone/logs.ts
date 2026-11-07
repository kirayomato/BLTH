import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { options } from './config'

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

/** 日志文件上限，超过后轮转出一份 .1 备份 */
const MAX_FILE_BYTES = 5 * 1024 * 1024

/**
 * 进程标识。
 *
 * 页面按 seq 增量拉取，而重启后 seq 会从头开始，沿旧序号拉取永远拿不到新记录；
 * 会话标识一旦变化，页面就知道该清空重取。
 */
export const logSession = Math.random().toString(36).slice(2, 10)

export const logFilePath = join(options.dataDir, 'blth.log')

const records: LogRecord[] = []

let nextSeq = 1
let fileBytes = 0
let fileWritable = true

try {
  // 首次运行时数据目录还不存在，文件日志得先把它建出来
  mkdirSync(options.dataDir, { recursive: true })
  if (existsSync(logFilePath)) {
    fileBytes = statSync(logFilePath).size
  }
} catch {
  // 目录或文件不可用时只保留内存日志
  fileWritable = false
}

const encoder = new TextEncoder()

/**
 * 记录一条控制台输出。
 *
 * 调用方已按当前等级过滤，因此这里不再判断等级：页面、文件与终端看到的内容一致。
 */
export function appendConsoleLog(level: ConsoleLogLevel, args: unknown[]): void {
  const { title, text } = splitArgs(args)
  const record: LogRecord = { seq: nextSeq++, time: Date.now(), level, title, text }

  records.push(record)
  if (records.length > MAX_RECORDS) {
    records.splice(0, records.length - MAX_RECORDS)
  }

  writeToFile(record)
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

function writeToFile(record: LogRecord): void {
  if (!fileWritable) {
    return
  }

  const line = `${formatTimestamp(record.time)} [${record.level}] ${record.title} ${record.text}\n`
  const bytes = encoder.encode(line).length

  try {
    if (fileBytes + bytes > MAX_FILE_BYTES) {
      rotateFile()
    }

    appendFileSync(logFilePath, line, 'utf-8')
    fileBytes += bytes
  } catch {
    // 磁盘不可写时停掉文件日志，内存缓冲照常，页面仍能看到后续日志
    fileWritable = false
  }
}

/** 把当前文件改名为 .1（旧备份直接覆盖），从空文件重新开始 */
function rotateFile(): void {
  const backup = `${logFilePath}.1`

  try {
    unlinkSync(backup)
  } catch {
    // 备份不存在，忽略
  }

  try {
    renameSync(logFilePath, backup)
  } catch {
    try {
      unlinkSync(logFilePath)
    } catch {
      // 两种方式都失败时继续追加，只是文件会超出上限
    }
  }

  fileBytes = 0
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

function formatTimestamp(time: number): string {
  const date = new Date(time)

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  )
}
