import Logger from '@/library/logger'
import { CANCELLED_NICK_NAME } from '@/library/utils'
import type LightTask from '@/modules/dailyTasks/liveTasks/medalTasks/lightTask'
import { useBiliStore, useModuleStore } from '@/stores'
import type { ModuleConfig, RoomidEntry } from '@/types'
import { runModule } from './runner'

/**
 * 任务进程与控制台之间的控制通道。
 *
 * 控制台从 stdin 逐行送入请求，任务进程把结果以带前缀的单行 JSON 写到 stdout；控制台按前缀
 * 把控制行与普通日志分开。配置与点赞必须落在任务进程内：模块实例、const 引用与 storage.json
 * 的防抖落盘都在这里，控制台只做转发，因此 storage.json 始终只有一个写入方。
 */

/** stdout 上的控制行前缀；ASCII RS 不会出现在普通日志行首 */
const CONTROL_PREFIX = '\u001eBLTHCTL'

/** 点赞任务模块名 */
const LIKE_MODULE_NAME = 'DailyTask_LiveTask_LightTask'

const logger = new Logger('Control')

interface ControlReply {
  status: number
  data: unknown
}

interface TaskEntry {
  /** 指向 moduleConfig 中承载开关值的对象，顺序即配置层级 */
  path: string[]
  /** 开关在上述对象上的字段名，缺省为 enabled */
  field?: string
  /** 对应的模块名，用于保存配置后触发新启用的任务 */
  moduleName: string
  group: string
  label: string
  /** 展示在开关右侧的补充说明，可为空 */
  hint?: string
  /** 是否为子开关，前端据此缩进并联动主开关的禁用态 */
  sub?: boolean
  /** 子开关所属主开关的 id */
  parent?: string
  /**
   * 是否为「参数型」开关：它只影响任务下次运行时的取值，打开时不必顺带重跑一轮模块
   * （例如点赞开关只是放行手动入口、观看时长分配开关只改变时长计算方式）
   */
  param?: boolean
}

/** 配置页面暴露的开关，覆盖任务启用状态与少量开关型参数 */
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
    param: true,
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
    path: ['DailyTasks', 'LiveTasks', 'medalTasks', 'watch'],
    field: 'autoAllocateTime',
    moduleName: 'DailyTask_LiveTask_WatchTask',
    group: '直播任务',
    label: '自动分配时长',
    hint: '按到 24:00 的剩余时间均摊给本次要观看的直播间；关闭后每个直播间都看满 storage.json 中设置的时长',
    sub: true,
    parent: 'DailyTasks.LiveTasks.medalTasks.watch',
    param: true,
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

function ok(data: unknown): ControlReply {
  return { status: 200, data }
}

function fail(status: number, message: string): ControlReply {
  return { status, data: { error: message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function listTasks(): unknown[] {
  return TASK_ENTRIES.map((entry) => ({
    id: entryId(entry),
    group: entry.group,
    label: entry.label,
    enabled: Boolean(taskTarget(entry)?.[entry.field ?? 'enabled']),
    hint: entry.hint,
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
  const newlyDisabled: TaskEntry[] = []

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
    } else {
      newlyDisabled.push(entry)
    }
  }

  cancelScheduled(newlyDisabled)
  runNewlyEnabled(newlyEnabled)
}

/**
 * 关闭主开关时撤掉已排的下次运行。
 *
 * 定时器回调直接调 `run()`，不看开关，留着的话关掉的任务到点仍会自行开跑。
 * 子开关与主开关共用同一个实例，撤排期只由主开关发起，否则关掉「发弹幕」会连带
 * 掐掉整个勋章任务的排期。
 */
function cancelScheduled(entries: TaskEntry[]): void {
  for (const entry of entries) {
    if (entry.field) {
      continue
    }

    const instance = useModuleStore().moduleInstances[entry.moduleName]
    if (!instance || instance.nextRunTimer === undefined) {
      continue
    }

    clearTimeout(instance.nextRunTimer)
    instance.nextRunTimer = undefined
  }
}

/** 打开的任务立即跑一轮，避免等到下一次排期 */
function runNewlyEnabled(entries: TaskEntry[]): void {
  const moduleStore = useModuleStore()

  for (const entry of entries) {
    // 参数型开关只影响模块后续运行时的取值，不必顺带重跑一轮
    if (entry.param) {
      continue
    }

    const instance = moduleStore.moduleInstances[entry.moduleName]
    if (!instance) {
      // 默认模块出错时 startModules 不会实例化任务模块，这里只提示，不去补建一份
      logger.warn(`【${entry.label}】已启用，但任务模块未实例化，重新启动任务后才会运行`)
      continue
    }
    if (!instance.isEnabled()) {
      continue
    }

    // 重新打开开关视为「现在就跑一次」：任务跑完会给自己排到次日零点，不撤掉旧定时器的话
    // 这里永远判定为已有排期，开关开了也不会有任何动静；撤掉后由本次运行重新排期，
    // 否则旧定时器到点还会再跑一轮，两轮各自排期会越叠越多。
    if (instance.nextRunTimer !== undefined) {
      clearTimeout(instance.nextRunTimer)
      instance.nextRunTimer = undefined
    }

    logger.log(`【${entry.label}】已启用，立即触发一次`)
    void runModule(entry.moduleName, instance)
  }
}

/** 当前处于打开状态的开关 id，用于在整份配置被改写后找出新打开的任务 */
function enabledTaskIds(): Set<string> {
  const ids = new Set<string>()

  for (const entry of TASK_ENTRIES) {
    if (Boolean(taskTarget(entry)?.[entry.field ?? 'enabled'])) {
      ids.add(entryId(entry))
    }
  }

  return ids
}

function readModuleConfigJson(): string {
  return JSON.stringify(useModuleStore().moduleConfig, null, 2)
}

/**
 * 就地覆盖配置对象。
 *
 * 各模块与 store 的 watch 都持有配置节点自身的引用，替换整个对象会让它们继续读旧数据，
 * 因此逐层改叶子值；source 中缺失的键按删除处理，删掉房间、弹幕之类的条目才会真正生效。
 */
function overwriteConfig(target: Record<string, any>, source: Record<string, any>): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      delete target[key]
    }
  }

  for (const [key, value] of Object.entries(source)) {
    const current = target[key]
    if (isPlainObject(current) && isPlainObject(value)) {
      overwriteConfig(current, value)
    } else {
      target[key] = value
    }
  }
}

/** 取配置中某个层级的节点；路径上任意一段缺失或不是普通对象都返回 undefined */
function pickConfigPath(node: unknown, path: string[]): unknown {
  let current: unknown = node

  for (const key of path) {
    if (!isPlainObject(current)) {
      return undefined
    }
    current = current[key]
  }

  return current
}

/** 提交的配置里缺失的任务节点。整份改写时少一个就等于把对应任务的配置删空 */
function missingTaskPaths(config: Record<string, any>): string[] {
  const missing = new Set<string>()

  for (const entry of TASK_ENTRIES) {
    if (!isPlainObject(pickConfigPath(config, entry.path))) {
      missing.add(entry.path.join('.'))
    }
  }

  return [...missing]
}

/** 应用页面提交的配置 JSON，返回规范化后的文本供页面回显 */
function applyModuleConfigJson(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`不是合法的 JSON：${messageOf(error)}`)
  }

  if (!isPlainObject(parsed)) {
    throw new Error('顶层必须是一个对象')
  }

  // 缺了 DailyTasks 的文本几乎一定是误删，放进去等于清空全部任务配置
  if (!isPlainObject(parsed.DailyTasks)) {
    throw new Error('缺少 DailyTasks，保存会清空所有任务配置，已拒绝')
  }

  const missing = missingTaskPaths(parsed)
  if (missing.length > 0) {
    throw new Error(
      `缺少任务节点 ${missing.join('、')}，保存会清空这些任务的配置，已拒绝；` +
        '不需要某个任务时请把它的 enabled 设为 false，不要删掉节点',
    )
  }

  const before = enabledTaskIds()
  overwriteConfig(useModuleStore().moduleConfig, parsed)

  const newlyEnabled = TASK_ENTRIES.filter(
    (entry) =>
      !before.has(entryId(entry)) && Boolean(taskTarget(entry)?.[entry.field ?? 'enabled']),
  )
  runNewlyEnabled(newlyEnabled)
  logger.log('配置 JSON 已更新')

  return readModuleConfigJson()
}

/** 取出点赞任务实例（模块在启动时已实例化，可能因主开关关闭而未启用） */
function getLightTask(): LightTask | undefined {
  return useModuleStore().moduleInstances[LIKE_MODULE_NAME] as unknown as LightTask | undefined
}

/** 是否正在收集点赞列表，避免并发重复请求 */
let likeCollecting = false

async function collectLikes(): Promise<ControlReply> {
  const instance = getLightTask()
  if (!instance) {
    return fail(500, '点赞模块未加载')
  }

  // 多标签页或连点都可能重复触发，收集期间直接拒绝，避免对接口造成双倍请求
  if (likeCollecting) {
    return fail(409, '正在收集点赞列表，请稍后')
  }
  // 每日自动点赞执行期间也会收集候选，避免两边互相覆盖候选列表
  if (instance.isManualLikeRunning) {
    return fail(409, '点赞任务正在运行中')
  }

  likeCollecting = true
  try {
    // 收集候选会逐个探测直播间、查询点赞进度，耗时与房间数成正比
    const snapshot = await instance.collectLikeCandidates()
    if (!snapshot) {
      return fail(409, '当前无法收集点赞列表，请查看运行日志')
    }
    return { status: 200, data: snapshot }
  } finally {
    likeCollecting = false
  }
}

function runLikes(payload: Record<string, any>): ControlReply {
  const instance = getLightTask()
  if (!instance) {
    return fail(500, '点赞模块未加载')
  }

  const roomids: unknown = payload.roomids
  const valid = Array.isArray(roomids)
    ? roomids.filter(
      (roomid): roomid is number =>
        typeof roomid === 'number' && Number.isInteger(roomid) && roomid > 0,
    )
    : []

  if (valid.length === 0) {
    return fail(400, 'roomids 不能为空')
  }

  if (instance.isManualLikeRunning) {
    return fail(409, '点赞任务正在运行中')
  }

  // 点赞本身耗时较长，立即返回，进度看运行日志
  logger.log(`配置页面触发点赞：${valid.length} 个直播间`)
  // likeRooms 内部的 IO 异常均已各自捕获，这里再兜一层：
  // 后台执行的 Promise 若抛出，避免形成未处理的 rejection 搞垮常驻进程
  instance.likeRooms(valid).catch((error: unknown) => {
    logger.error(`配置页面触发点赞出错：${messageOf(error)}`)
  })

  return { status: 202, data: { accepted: true } }
}

/* ---------------- 粉丝勋章名单 ---------------- */

/** 名单编辑用的直播间行，字段与网页版的 MedalRow 一致 */
interface MedalRow {
  roomid: number
  uid: number
  nick_name: string
  medal_name: string
  medal_level: number
  avatar: string
  is_lighted: boolean
  is_canceled: boolean
}

/** 名单相关配置节点：白/黑名单开关与两个房间名单都在这里 */
function medalTasksConfig(): ModuleConfig['DailyTasks']['LiveTasks']['medalTasks'] {
  return useModuleStore().moduleConfig.DailyTasks.LiveTasks.medalTasks
}

/**
 * 把粉丝勋章快照转成名单表格的行
 *
 * 账号已注销的昵称用名单里存的原名兜底，便于与历史配置对上。
 */
function medalRows(): MedalRow[] {
  const config = medalTasksConfig()
  const storedName = new Map<number, string>()
  for (const entry of [...config.roomidList, ...config.roomidList2]) {
    if (entry.name && !storedName.has(entry.roomid)) {
      storedName.set(entry.roomid, entry.name)
    }
  }

  return useBiliStore().filteredFansMedals.map((medal) => {
    const roomid = medal.room_info.room_id
    const isCanceled = medal.anchor_info.nick_name === CANCELLED_NICK_NAME
    return {
      roomid,
      uid: medal.medal.target_id,
      nick_name: isCanceled
        ? storedName.get(roomid) || CANCELLED_NICK_NAME
        : medal.anchor_info.nick_name,
      medal_name: medal.medal.medal_name,
      medal_level: medal.medal.level,
      avatar: medal.anchor_info.avatar,
      is_lighted: medal.medal.is_lighted === 1,
      is_canceled: isCanceled,
    }
  })
}

function readMedalLists(): ControlReply {
  const config = medalTasksConfig()
  return ok({
    rows: medalRows(),
    isWhiteList: config.isWhiteList,
    roomidList: config.roomidList.map((entry) => entry.roomid),
    roomidList2: config.roomidList2.map((entry) => entry.roomid),
    status: useBiliStore().fansMedalsStatus ?? '',
  })
}

function writeMedalList(payload: Record<string, any>): ControlReply {
  const mode: unknown = payload.mode
  if (mode !== 'list' && mode !== 'priority') {
    return fail(400, 'mode 只能是 list 或 priority')
  }

  const raw: unknown = payload.roomids
  if (!Array.isArray(raw)) {
    return fail(400, 'roomids 必须是数组')
  }

  const roomids = raw.filter(
    (roomid): roomid is number =>
      typeof roomid === 'number' && Number.isInteger(roomid) && roomid > 0,
  )

  const config = medalTasksConfig()

  // 白名单开关只作用于主名单，优先名单与它无关
  if (mode === 'list' && typeof payload.isWhiteList === 'boolean') {
    config.isWhiteList = payload.isWhiteList
  }

  // 用户名允许留空：运行时获取到粉丝勋章后会自动补全
  const nameByRoomid = new Map(medalRows().map((row) => [row.roomid, row.nick_name]))
  const entries: RoomidEntry[] = roomids.map((roomid) => ({
    roomid,
    name: nameByRoomid.get(roomid) ?? '',
  }))

  if (mode === 'priority') {
    config.roomidList2 = entries
  } else {
    config.roomidList = entries
  }

  const label = mode === 'priority' ? '优先名单' : '黑白名单'
  logger.log(`名单已更新：${label} ${entries.length} 个直播间`)

  return readMedalLists()
}

async function dispatch(action: string, payload: Record<string, any>): Promise<ControlReply> {
  switch (action) {
    case 'tasks.get':
      return ok({ tasks: listTasks() })

    case 'tasks.set':
      applyTasks(Array.isArray(payload.tasks) ? payload.tasks : [])
      return ok({ tasks: listTasks() })

    case 'modules.get':
      return ok({ json: readModuleConfigJson() })

    case 'modules.set': {
      if (typeof payload.json !== 'string') {
        return fail(400, 'json 字段必须是字符串')
      }
      try {
        return ok({ json: applyModuleConfigJson(payload.json) })
      } catch (error) {
        return fail(400, messageOf(error))
      }
    }

    case 'like.get':
      return collectLikes()

    case 'like.set':
      return runLikes(payload)

    case 'medals.get':
      return readMedalLists()

    case 'medals.set':
      return writeMedalList(payload)

    case 'watch.get':
      return ok(useModuleStore().liveWatchInfo)

    default:
      return fail(404, `未知操作 ${action}`)
  }
}

async function handleLine(line: string): Promise<void> {
  let request: { id?: unknown; action?: unknown; payload?: unknown }

  try {
    request = JSON.parse(line) as typeof request
  } catch {
    return
  }

  if (typeof request.id !== 'number' || typeof request.action !== 'string') {
    return
  }

  const payload = isPlainObject(request.payload) ? request.payload : {}
  let reply: ControlReply

  try {
    reply = await dispatch(request.action, payload)
  } catch (error) {
    reply = fail(500, messageOf(error))
  }

  // 直接写 stdout 而不经过 console：日志等级为 none 时控制响应也必须送达
  try {
    process.stdout.write(`${CONTROL_PREFIX}${JSON.stringify({ id: request.id, ...reply })}\n`)
  } catch {
    // 控制台已断开，管道写失败不该变成未处理的 rejection 影响任务
  }
}

/**
 * 开始接收控制台请求。
 *
 * 由入口在 store 初始化之后调用；stdin 保持打开意味着直接以 node 启动（不带控制台）时
 * 进程也不会因此退出，但收不到请求，配置请直接编辑 data/storage.json 后重启。
 */
export function startControlChannel(): void {
  let buffer = ''

  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk

    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line) {
        void handleLine(line)
      }
      index = buffer.indexOf('\n')
    }
  })
  process.stdin.on('end', () => {
    buffer = ''
  })
}
