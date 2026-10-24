import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import Logger from '@/library/logger'
import { useModuleStore } from '@/stores'
import type LightTask from '@/modules/dailyTasks/liveTasks/medalTasks/lightTask'
import { getLogLevel, isLogLevel, options, setLogLevel, type LogLevel } from './config'
import { runModule } from './runner'
import { configPageHtml } from './web-page'
import { storage } from './storage'

const logger = new Logger('Server')

interface TaskEntry {
  /** 指向 moduleConfig 中承载开关值的对象，顺序即配置层级 */
  path: string[]
  /** 开关在上述对象上的字段名，缺省为 enabled */
  field?: string
  /** 对应的模块名，用于保存配置后触发新启用的任务 */
  moduleName: string
  group: string
  label: string
  /** 是否为子开关，前端据此缩进并联动主开关的禁用态 */
  sub?: boolean
  /** 子开关所属主开关的 id */
  parent?: string
}

/**
 * 配置页面暴露的开关。
 *
 * 只覆盖任务的启用状态；任务参数（投币数量、观看时长、弹幕列表、房间名单等）
 * 仍由 data/storage.json 维护。
 */
const TASK_ENTRIES: TaskEntry[] = [
  {
    path: ['DailyTasks', 'MainSiteTasks', 'login'],
    moduleName: 'DailyTask_MainSiteTask_LoginTask',
    group: '主站任务',
    label: '每日登录',
  },
  {
    path: ['DailyTasks', 'MainSiteTasks', 'watch'],
    moduleName: 'DailyTask_MainSiteTask_WatchTask',
    group: '主站任务',
    label: '每日观看视频',
  },
  {
    path: ['DailyTasks', 'MainSiteTasks', 'coin'],
    moduleName: 'DailyTask_MainSiteTask_CoinTask',
    group: '主站任务',
    label: '每日投币',
  },
  {
    path: ['DailyTasks', 'MainSiteTasks', 'share'],
    moduleName: 'DailyTask_MainSiteTask_ShareTask',
    group: '主站任务',
    label: '每日分享视频',
  },
  {
    path: ['DailyTasks', 'LiveTasks', 'medalTasks', 'light'],
    moduleName: 'DailyTask_LiveTask_LightTask',
    group: '直播任务',
    label: '点亮熄灭勋章',
  },
  {
    path: ['DailyTasks', 'LiveTasks', 'medalTasks', 'light'],
    field: 'likeEnabled',
    moduleName: 'DailyTask_LiveTask_LightTask',
    group: '直播任务',
    label: '点赞（在下方手动触发）',
    sub: true,
    parent: 'DailyTasks.LiveTasks.medalTasks.light',
  },
  {
    path: ['DailyTasks', 'LiveTasks', 'medalTasks', 'light'],
    field: 'danmuEnabled',
    moduleName: 'DailyTask_LiveTask_LightTask',
    group: '直播任务',
    label: '发弹幕',
    sub: true,
    parent: 'DailyTasks.LiveTasks.medalTasks.light',
  },
  {
    path: ['DailyTasks', 'LiveTasks', 'medalTasks', 'watch'],
    moduleName: 'DailyTask_LiveTask_WatchTask',
    group: '直播任务',
    label: '观看直播',
  },
  {
    path: ['DailyTasks', 'OtherTasks', 'silverToCoin'],
    moduleName: 'DailyTask_OtherTask_SilverToCoinTask',
    group: '其它任务',
    label: '银瓜子换硬币',
  },
  {
    path: ['DailyTasks', 'OtherTasks', 'coinToSilver'],
    moduleName: 'DailyTask_OtherTask_CoinToSilverTask',
    group: '其它任务',
    label: '硬币换银瓜子',
  },
  {
    path: ['DailyTasks', 'OtherTasks', 'getYearVipPrivilege'],
    moduleName: 'DailyTask_OtherTask_GetYearVipPrivilegeTask',
    group: '其它任务',
    label: '领取年度大会员权益',
  },
]

interface TaskView {
  id: string
  group: string
  label: string
  enabled: boolean
  sub?: boolean
  parent?: string
}

/** 配置对象中承载开关值的那个节点 */
function taskTarget(entry: TaskEntry): Record<string, any> | undefined {
  let node: any = useModuleStore().moduleConfig

  for (const key of entry.path) {
    node = node?.[key]
    if (node == null) {
      return undefined
    }
  }

  return node
}

function entryId(entry: TaskEntry): string {
  return entry.path.join('.') + (entry.field ? `.${entry.field}` : '')
}

function listTasks(): TaskView[] {
  return TASK_ENTRIES.map((entry) => ({
    id: entryId(entry),
    group: entry.group,
    label: entry.label,
    enabled: Boolean(taskTarget(entry)?.[entry.field ?? 'enabled']),
    sub: entry.sub,
    parent: entry.parent,
  }))
}

/**
 * 应用开关变更。
 *
 * 直接改写 moduleConfig 上的属性而不替换对象，这样各模块持有的配置引用仍然有效；
 * 变更会经由 store 内部的防抖 watch 自动落盘。
 */
function applyTasks(updates: { id?: string; enabled?: unknown }[]): void {
  const newlyEnabled: TaskEntry[] = []

  for (const update of updates) {
    const entry = TASK_ENTRIES.find((item) => entryId(item) === update.id)
    if (!entry) {
      continue
    }

    const field = entry.field ?? 'enabled'
    const enabled = Boolean(update.enabled)
    const target = taskTarget(entry)
    if (!target || target[field] === enabled) {
      continue
    }

    target[field] = enabled
    if (enabled) {
      newlyEnabled.push(entry)
    }
  }

  const moduleStore = useModuleStore()

  for (const entry of newlyEnabled) {
    // 点赞已改为手动运行，打开开关只是放行手动入口，不必顺带重跑一轮模块
    if (entry.field === 'likeEnabled') {
      continue
    }

    const instance = moduleStore.moduleInstances[entry.moduleName]
    if (!instance || !instance.isEnabled() || instance.nextRunTimer) {
      continue
    }

    logger.log(`【${entry.label}】已启用，立即触发一次`)
    void runModule(entry.moduleName, instance)
  }
}

/** 点赞任务模块名 */
const LIKE_MODULE_NAME = 'DailyTask_LiveTask_LightTask'

/** 取出点赞任务实例（模块在启动时已实例化，可能因主开关关闭而未启用） */
function getLightTask(): LightTask | undefined {
  return useModuleStore().moduleInstances[LIKE_MODULE_NAME] as unknown as LightTask | undefined
}

/** 是否正在收集点赞列表，避免并发重复请求 */
let likeCollecting = false

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = []
    request.setEncoding('utf-8')
    request.on('data', (chunk: string) => chunks.push(chunk))
    request.on('end', () => resolve(chunks.join('')))
    request.on('error', reject)
  })
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(data))
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = request.url ?? '/'

  if (request.method === 'GET' && (url === '/' || url === '/index.html')) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(configPageHtml)
    return
  }

  if (url === '/api/tasks') {
    if (request.method === 'GET') {
      sendJson(response, 200, { tasks: listTasks() })
      return
    }

    if (request.method === 'POST') {
      const body = await readBody(request)

      let payload: { tasks?: { id?: string; enabled?: unknown }[] }
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        sendJson(response, 400, { error: '请求体不是合法的 JSON' })
        return
      }

      applyTasks(Array.isArray(payload.tasks) ? payload.tasks : [])
      sendJson(response, 200, { tasks: listTasks() })
      return
    }
  }

  if (url === '/api/like') {
    const instance = getLightTask()
    if (!instance) {
      sendJson(response, 500, { error: '点赞模块未加载' })
      return
    }

    if (request.method === 'GET') {
      // 多标签页或连点都可能重复触发，收集期间直接拒绝，避免对接口造成双倍请求
      if (likeCollecting) {
        sendJson(response, 409, { error: '正在收集点赞列表，请稍后' })
        return
      }

      likeCollecting = true
      try {
        // 收集候选会逐个探测直播间、查询点赞进度，耗时与房间数成正比
        const snapshot = await instance.collectLikeCandidates()
        if (!snapshot) {
          sendJson(response, 409, { error: '当前无法收集点赞列表，请查看运行日志' })
          return
        }
        sendJson(response, 200, snapshot)
      } finally {
        likeCollecting = false
      }
      return
    }

    if (request.method === 'POST') {
      const body = await readBody(request)

      let payload: { roomids?: unknown }
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        sendJson(response, 400, { error: '请求体不是合法的 JSON' })
        return
      }

      const roomids = Array.isArray(payload.roomids)
        ? payload.roomids.filter(
            (roomid): roomid is number =>
              typeof roomid === 'number' && Number.isInteger(roomid) && roomid > 0,
          )
        : []

      if (roomids.length === 0) {
        sendJson(response, 400, { error: 'roomids 不能为空' })
        return
      }

      if (instance.isManualLikeRunning) {
        sendJson(response, 409, { error: '点赞任务正在运行中' })
        return
      }

      // 点赞本身耗时较长，立即返回，进度看运行日志
      logger.log(`配置页面触发点赞：${roomids.length} 个直播间`)
      // likeRooms 内部的 IO 异常均已各自捕获，这里再兜一层：
      // 后台执行的 Promise 若抛出，避免形成未处理的 rejection 搞垮常驻进程
      instance.likeRooms(roomids).catch((error: unknown) => {
        logger.error(
          `配置页面触发点赞出错：${error instanceof Error ? error.message : String(error)}`,
        )
      })
      sendJson(response, 202, { accepted: true })
      return
    }
  }

  if (url === '/api/config') {
    if (request.method === 'GET') {
      sendJson(response, 200, { logLevel: getLogLevel() })
      return
    }

    if (request.method === 'POST') {
      const body = await readBody(request)

      let payload: { logLevel?: unknown }
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        sendJson(response, 400, { error: '请求体不是合法的 JSON' })
        return
      }

      if (!isLogLevel(payload.logLevel)) {
        sendJson(response, 400, { error: '非法的日志等级' })
        return
      }

      // 先按旧等级打印确认，再切换到新等级（否则在设置 none/error 时自身反而不可见）
      logger.log(`日志等级已调整为 ${payload.logLevel}`)
      setLogLevel(payload.logLevel)
      storage.set('logLevel', payload.logLevel)
      sendJson(response, 200, { logLevel: getLogLevel() })
      return
    }
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end('Not Found')
}

/**
 * 启动配置页面。
 *
 * 只监听回环地址：配置中包含房间名单与弹幕内容，不应暴露到公网。
 */
export function startConfigServer(): void {
  if (!options.configEnabled) {
    logger.log('配置页面已关闭')
    return
  }

  // 应用配置页面上一次保存的日志等级，覆盖环境变量默认值（用户最后的显式选择优先）
  const persisted = storage.get<LogLevel>('logLevel', options.logLevel)
  if (isLogLevel(persisted)) {
    setLogLevel(persisted)
  }

  const server = createServer((request, response) => {
    handle(request, response).catch((error: Error) => {
      logger.error(`处理请求出错：${error.message}`)
      try {
        sendJson(response, 500, { error: error.message })
      } catch {
        // 响应可能已经发出，忽略
      }
    })
  })

  server.on('error', (error: Error) => {
    logger.error(`配置页面启动失败：${error.message}`)
  })

  server.listen(options.configPort, '127.0.0.1', () => {
    logger.log(`配置页面：http://127.0.0.1:${options.configPort}`)
  })
}
