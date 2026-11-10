/**
 * 独立运行版用到的 Node API 最小声明。
 *
 * 刻意不引入 @types/node：它的全局声明会把 setTimeout 的返回类型换成 NodeJS.Timeout，
 * 而共享源码中的 BaseModule.nextRunTimer 依赖 DOM lib 给出的 number。
 */

declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function readFileSync(path: string, encoding: 'utf-8'): string
  export function writeFileSync(path: string, data: string, encoding: 'utf-8'): void
  export function renameSync(oldPath: string, newPath: string): void
  export function mkdirSync(path: string, options: { recursive: boolean }): string | undefined
  export function unlinkSync(path: string): void
}

declare module 'node:path' {
  export function join(...paths: string[]): string
  export function resolve(...paths: string[]): string
  export function dirname(path: string): string
}

declare module 'node:http' {
  export interface IncomingMessage {
    method?: string
    url?: string
    setEncoding(encoding: string): void
    on(event: string, listener: (...args: any[]) => void): void
  }

  export interface ServerResponse {
    writeHead(statusCode: number, headers?: Record<string, string>): void
    end(data?: string): void
  }

  export interface Server {
    listen(port: number, hostname: string, callback?: () => void): void
    close(callback?: () => void): void
    on(event: string, listener: (...args: any[]) => void): void
  }

  export function createServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Server
}

declare const process: {
  env: Record<string, string | undefined>
  argv: string[]
  cwd(): string
  exit(code?: number): never
  platform: string
  version: string
  on(event: string, listener: (...args: any[]) => void): void
  once(event: string, listener: (...args: any[]) => void): void
}
