import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { options } from './config'

/**
 * 以单个 JSON 文件作为 GM_setValue / GM_getValue 的后端。
 *
 * 写入时先落临时文件再改名，避免进程在写入途中退出时留下半截文件。
 */
class JsonStorage {
  private readonly file: string

  private data: Record<string, any> | undefined

  constructor(file: string) {
    this.file = file
  }

  public get path(): string {
    return this.file
  }

  public get<T>(key: string, defaultValue: T): T {
    const value = this.load()[key]
    return value === undefined ? defaultValue : (value as T)
  }

  public set(key: string, value: any): void {
    this.load()[key] = value
    this.flush()
  }

  public delete(key: string): void {
    delete this.load()[key]
    this.flush()
  }

  public keys(): string[] {
    return Object.keys(this.load())
  }

  public flush(): void {
    const directory = dirname(this.file)
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true })
    }

    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify(this.load(), null, 2), 'utf-8')
    renameSync(temporary, this.file)
  }

  private load(): Record<string, any> {
    if (this.data) {
      return this.data
    }

    if (!existsSync(this.file)) {
      this.data = {}
      return this.data
    }

    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf-8'))
      this.data = parsed && typeof parsed === 'object' ? (parsed as Record<string, any>) : {}
    } catch {
      // 文件损坏时保留现场，重新从空对象开始
      const broken = `${this.file}.broken`
      try {
        renameSync(this.file, broken)
      } catch {
        try {
          unlinkSync(this.file)
        } catch {
          // 已经无法处理，忽略
        }
      }
      this.data = {}
    }

    return this.data
  }
}

export const storage = new JsonStorage(join(options.dataDir, 'storage.json'))
