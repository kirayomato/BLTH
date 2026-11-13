<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, ElTable } from 'element-plus'
import { CANCELLED_NICK_NAME } from '@/library/utils/constants'
import type {
  LikeCandidateSnapshot,
  LikeRoomCandidate,
} from '@/modules/dailyTasks/liveTasks/medalTasks/types'
import type { LiveWatchInfo } from '@/stores'

interface TaskView {
  id: string
  group: string
  label: string
  enabled: boolean
  hint?: string
  sub?: boolean
  parent?: string
}

/** 数值参数（如观看时长）：与开关不同的常用设置，直接以输入框呈现 */
interface ParamView {
  id: string
  group: string
  label: string
  value: number
  unit: string
  min: number
  max: number
  hint?: string
  /** 挂在哪一行开关下面：值为该开关的 id，渲染时紧跟其后 */
  after: string
}

const tasks = ref<TaskView[]>([])
const params = ref<ParamView[]>([])
const saving = ref(false)
const paramSaving = ref(false)
/** 参数保存的防抖定时器 */
let paramSaveTimer: number | undefined
const error = ref('')

/* ---------------- 账号 ---------------- */

interface AccountView {
  name: string
  running: boolean
  pid: number | null
  startedAt: number | null
  exitCode: number | null
  control: boolean
}

const accounts = ref<AccountView[]>([])
const currentAccount = ref('')
const accountError = ref('')

/** 当前账号作用域的接口地址 */
function accountEndpoint(rest: string): string {
  return `/api/accounts/${encodeURIComponent(currentAccount.value)}/${rest}`
}

async function loadAccounts(prefer?: string): Promise<void> {
  try {
    const response = await fetch('/api/accounts')
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const data = (await response.json()) as { accounts: AccountView[] }
    accounts.value = data.accounts
    if (!data.accounts.some((item) => item.name === currentAccount.value)) {
      currentAccount.value = prefer ?? data.accounts[0]?.name ?? ''
    }
    accountError.value = ''
  } catch (err) {
    accountError.value = `读取账号列表失败：${(err as Error).message}`
  }
}

/** 切换到指定账号：重置与该账号相关的缓存态，避免串号；force 用于账号已选中但尚未加载数据的首次激活 */
async function selectAccount(name: string, force = false): Promise<void> {
  if (!name || (!force && name === currentAccount.value)) {
    return
  }
  // 切换账号时丢掉尚未提交的参数改动，避免把旧账号的数值写给新账号
  window.clearTimeout(paramSaveTimer)
  currentAccount.value = name
  logSession.value = ''
  logLastSeq = 0
  logRecords.value = []
  medalLoaded.value = false
  medalRows.value = []
  medalListRoomids.value = []
  medalPriorityRoomids.value = []
  medalIsWhiteList.value = false
  likeCandidates.value = []
  likeSelection.value = []
  liveWatchInfo.value = null
  tasks.value = []
  params.value = []
  await Promise.all([load(), loadConfigJson()])
  await fetchLogs(0)
}

function onAccountTabChange(name: string | number): void {
  void selectAccount(String(name))
}

/* ---------------- 新增 / 删除账号 ---------------- */

const addAccountVisible = ref(false)
const addAccountName = ref('')
const addAccountCookie = ref('')
const addAccountSaving = ref(false)

function openAddAccount(): void {
  addAccountName.value = ''
  addAccountCookie.value = ''
  addAccountVisible.value = true
}

async function createAccount(): Promise<void> {
  const name = addAccountName.value.trim()
  if (!name) {
    ElMessage.warning('请输入账号名')
    return
  }
  addAccountSaving.value = true
  try {
    const response = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cookie: addAccountCookie.value }),
    })
    const data = (await response.json()) as { error?: string }
    if (!response.ok) {
      throw new Error(data.error ?? `HTTP ${response.status}`)
    }
    addAccountVisible.value = false
    ElMessage.success(`已新增账号「${name}」并启动`)
    await loadAccounts(name)
    await selectAccount(name, true)
  } catch (err) {
    ElMessage.error(`新增账号失败：${(err as Error).message}`)
  } finally {
    addAccountSaving.value = false
  }
}

async function removeCurrentAccount(): Promise<void> {
  const name = currentAccount.value
  if (!name) {
    return
  }
  try {
    await ElMessageBox.confirm(
      `会停止账号「${name}」的任务进程并从列表移除；其 cookie 与配置目录（data/accounts/${name}/）保留在磁盘上，之后可再手动放回。`,
      '删除账号',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    const response = await fetch(`/api/accounts/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      throw new Error(data.error ?? `HTTP ${response.status}`)
    }
    ElMessage.success(`已删除账号「${name}」`)
    accounts.value = accounts.value.filter((item) => item.name !== name)
    currentAccount.value = ''
    const next = accounts.value[0]
    if (next) {
      await selectAccount(next.name)
    } else {
      tasks.value = []
      params.value = []
    }
  } catch (err) {
    ElMessage.error(`删除账号失败：${(err as Error).message}`)
  }
}

const groups = computed(() => {
  const result: { name: string; tasks: TaskView[] }[] = []

  for (const task of tasks.value) {
    let group = result.find((item) => item.name === task.group)
    if (!group) {
      group = { name: task.group, tasks: [] }
      result.push(group)
    }
    group.tasks.push(task)
  }

  return result
})

/** 子开关在主开关关闭时禁用，与浏览器版控制面板的行为一致 */
function isDisabled(task: TaskView): boolean {
  if (!task.parent) {
    return false
  }
  return !tasks.value.some((item) => item.id === task.parent && item.enabled)
}

/** 挂在指定开关后面的参数：每个参数紧跟它所属的那行开关，读起来才不脱节 */
function paramsAfter(group: string, taskId: string): ParamView[] {
  return params.value.filter((param) => param.group === group && param.after === taskId)
}

async function load(): Promise<void> {
  try {
    const [taskResponse, paramResponse] = await Promise.all([
      fetch(accountEndpoint('tasks')),
      fetch(accountEndpoint('params')),
    ])
    if (!taskResponse.ok) {
      throw new Error(`HTTP ${taskResponse.status}`)
    }
    if (!paramResponse.ok) {
      throw new Error(`HTTP ${paramResponse.status}`)
    }

    const taskData = (await taskResponse.json()) as { tasks: TaskView[] }
    const paramData = (await paramResponse.json()) as { params: ParamView[] }
    tasks.value = taskData.tasks
    params.value = paramData.params
    error.value = ''
  } catch (err) {
    error.value = `读取配置失败：${(err as Error).message}`
  }
}

/** 单独重读参数：保存失败时用来把输入框恢复成任务进程里的实际值 */
async function loadParams(): Promise<void> {
  try {
    const response = await fetch(accountEndpoint('params'))
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const data = (await response.json()) as { params: ParamView[] }
    params.value = data.params
  } catch (err) {
    ElMessage.error(`读取参数失败：${(err as Error).message}`)
  }
}

/** 参数改动后的落盘延迟：连续按方向键或用上下箭头时不该每一下都发一次请求 */
const PARAM_SAVE_DELAY = 400

function scheduleParamSave(): void {
  window.clearTimeout(paramSaveTimer)
  paramSaveTimer = window.setTimeout(() => void saveParams(), PARAM_SAVE_DELAY)
}

async function saveParams(): Promise<void> {
  if (paramSaving.value) {
    // 上一笔还没回来：等它结束再提交，避免并发写同一个参数
    scheduleParamSave()
    return
  }

  paramSaving.value = true

  try {
    const response = await fetch(accountEndpoint('params'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        params: params.value.map((param) => ({ id: param.id, value: param.value })),
      }),
    })
    const data = (await response.json()) as { params?: ParamView[]; error?: string }

    if (!response.ok) {
      throw new Error(data.error ?? `HTTP ${response.status}`)
    }

    if (data.params) {
      params.value = data.params
    }
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(`保存失败：${(err as Error).message}`)
    await loadParams()
  } finally {
    paramSaving.value = false
  }
}

async function save(): Promise<void> {
  saving.value = true

  try {
    const response = await fetch(accountEndpoint('tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tasks: tasks.value.map((task) => ({ id: task.id, enabled: task.enabled })),
      }),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const data = (await response.json()) as { tasks: TaskView[] }
    tasks.value = data.tasks
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error(`保存失败：${(err as Error).message}`)
    await load()
  } finally {
    saving.value = false
  }
}

/* ---------------- 运行日志 ---------------- */

const RECORD_LEVELS = ['debug', 'info', 'warn', 'error'] as const

type RecordLevel = (typeof RECORD_LEVELS)[number]

interface LogRecord {
  seq: number
  time: number
  level: RecordLevel
  title: string
  text: string
}

/** 页面保留的最短时长：这段时间内的记录不因条数被挤掉，与服务端缓冲一致 */
const LOG_KEEP_MS = 60 * 60 * 1000

/** 页面渲染上限，仅在保底时长内仍超限时才按条数丢弃 */
const MAX_LOG_RECORDS = 5000

const logRecords = ref<LogRecord[]>([])
const logSession = ref('')
/** 默认隐藏 debug：全部等级都会记录，页面上先只看要点 */
const logLevelFilter = ref<RecordLevel[]>(['info', 'warn', 'error'])
const logModule = ref<string>()
const logKeyword = ref('')
const logAutoScroll = ref(true)
const logPaused = ref(false)
const logViewRef = ref<HTMLElement>()

/** 已拉取到的最新序号；进程重启后由会话标识变化触发重取 */
let logLastSeq = 0
let logTimer: number | undefined
let logReloadTimer: number | undefined
/** 每次筛选重取换一代，晚到的旧响应直接丢弃，避免和重扫结果混在一起 */
let logGeneration = 0

/** 模块候选由服务端在整段缓冲里去重给出，不受当前筛选影响 */
const logModules = ref<string[]>([])

/** 筛选条件变化后的重取延时：关键词逐字输入不该每敲一下都发一次请求 */
const LOG_RELOAD_DELAY = 300

/** 按时间保底、条数兜底淘汰：保底时长内的日志不因条数被挤掉 */
function trimLogRecords(): void {
  const records = logRecords.value
  if (records.length <= MAX_LOG_RECORDS) {
    return
  }

  // 以最新记录的时间为基准，不依赖浏览器时钟
  const oldestKept = records[records.length - 1].time - LOG_KEEP_MS
  let drop = 0
  while (records.length - drop > MAX_LOG_RECORDS && records[drop].time <= oldestKept) {
    drop += 1
  }
  if (records.length - drop > MAX_LOG_RECORDS) {
    drop = records.length - MAX_LOG_RECORDS
  }

  records.splice(0, drop)
}

/** 等级、模块、关键词都在控制台进程里筛，页面只收要显示的记录 */
function logQuery(after: number): string {
  const params = new URLSearchParams({
    after: String(after),
    limit: String(MAX_LOG_RECORDS),
    level: logLevelFilter.value.join(','),
  })

  if (logModule.value) {
    params.set('title', logModule.value)
  }
  if (logKeyword.value.trim()) {
    params.set('keyword', logKeyword.value.trim())
  }

  return params.toString()
}

async function fetchLogs(after: number): Promise<void> {
  const generation = logGeneration
  const response = await fetch(`${accountEndpoint('logs')}?${logQuery(after)}`, { cache: 'no-store' })
  if (!response.ok || generation !== logGeneration) {
    return
  }

  const data = (await response.json()) as {
    session: string
    records: LogRecord[]
    lastSeq: number
    modules: string[]
  }

  if (generation !== logGeneration) {
    return
  }

  if (data.session !== logSession.value) {
    // 重启后序号从头开始，不清空重取的话增量永远对不上
    logSession.value = data.session
    logRecords.value = []
    logLastSeq = 0

    if (after !== 0) {
      await fetchLogs(0)
      return
    }
  }

  if (data.modules.length > 0) {
    logModules.value = data.modules
  }

  if (data.records.length === 0) {
    // 这一轮没有匹配的记录也要推进序号，否则每轮都在重扫同一段
    logLastSeq = Math.max(logLastSeq, data.lastSeq)
    return
  }

  logRecords.value.push(...data.records)
  trimLogRecords()

  logLastSeq = data.lastSeq
  void scrollLogToBottom()
}

/** 筛选条件变了就从头重取：序号归零，由服务端按新条件重扫缓冲 */
function reloadLogs(): void {
  window.clearTimeout(logReloadTimer)
  logReloadTimer = window.setTimeout(() => {
    logGeneration += 1
    logRecords.value = []
    logLastSeq = 0
    void fetchLogs(0)
  }, LOG_RELOAD_DELAY)
}

watch([logLevelFilter, logModule, logKeyword], reloadLogs, { deep: true })

async function pollLogs(): Promise<void> {
  try {
    // 页面不可见时不拉取，切回来后一次性补齐
    if (!logPaused.value && !document.hidden) {
      await fetchLogs(logLastSeq)
    }
  } catch {
    // 重启期间服务不可用，留着序号下一轮再试
  } finally {
    logTimer = window.setTimeout(pollLogs, 1000)
  }
}

async function scrollLogToBottom(): Promise<void> {
  if (!logAutoScroll.value) {
    return
  }

  await nextTick()
  const view = logViewRef.value
  if (view) {
    view.scrollTop = view.scrollHeight
  }
}

function toggleLogPause(): void {
  logPaused.value = !logPaused.value
  if (!logPaused.value) {
    void scrollLogToBottom()
  }
}

function clearLogView(): void {
  // 只清页面上的记录：序号要接着用，否则下一轮会把整个缓冲重新拉回来
  logRecords.value = []
}

function formatClock(time: number): string {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')

  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

watch(logAutoScroll, (enabled) => {
  if (enabled) {
    void scrollLogToBottom()
  }
})

/* ---------------- 配置 JSON ---------------- */

const configJson = ref('')
const configJsonLoading = ref(false)
const configJsonSaving = ref(false)
const configJsonError = ref('')

async function loadConfigJson(): Promise<void> {
  configJsonLoading.value = true

  try {
    const response = await fetch(accountEndpoint('modules'), { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const data = (await response.json()) as { json: string }
    configJson.value = data.json
    configJsonError.value = ''
  } catch (err) {
    ElMessage.error(`读取配置失败：${(err as Error).message}`)
  } finally {
    configJsonLoading.value = false
  }
}

/** 只在本地校验并重排文本，不提交 */
function formatConfigJson(): void {
  try {
    configJson.value = JSON.stringify(JSON.parse(configJson.value), null, 2)
    configJsonError.value = ''
  } catch (err) {
    configJsonError.value = `不是合法的 JSON：${(err as Error).message}`
  }
}

async function saveConfigJson(): Promise<void> {
  configJsonSaving.value = true

  try {
    const response = await fetch(accountEndpoint('modules'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: configJson.value }),
    })
    const data = (await response.json()) as { json?: string; error?: string }

    if (!response.ok) {
      throw new Error(data.error ?? `HTTP ${response.status}`)
    }

    configJson.value = data.json ?? configJson.value
    configJsonError.value = ''
    ElMessage.success('已保存，配置立即生效')

    // 开关也可能一起被改写，同步刷新上方的任务卡片
    await load()
  } catch (err) {
    configJsonError.value = (err as Error).message
    ElMessage.error(`保存失败：${(err as Error).message}`)
  } finally {
    configJsonSaving.value = false
  }
}

/* ---------------- 任务进程 ---------------- */

interface ProcessStatus {
  running: boolean
  pid: number | null
  startedAt: number | null
  exitCode: number | null
  control: boolean
}

const restarting = ref(false)
const processStatus = ref<ProcessStatus | null>(null)
let statusTimer: number | undefined

const statusText = computed(() => {
  const status = processStatus.value
  if (!status) {
    return '正在连接控制台…'
  }
  if (!status.running) {
    return `任务进程已停止（退出码 ${status.exitCode ?? '—'}）`
  }

  const since = status.startedAt
    ? new Date(status.startedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : '—'
  const control = status.control ? '' : ' · 控制通道未就绪'
  return `任务进程运行中 · PID ${status.pid} · 启动于 ${since}${control}`
})

async function pollStatus(): Promise<void> {
  try {
    const response = await fetch(accountEndpoint('status'), { cache: 'no-store' })
    if (response.ok) {
      processStatus.value = (await response.json()) as ProcessStatus
    }
  } catch {
    // 控制台自身重启期间保留上一次状态
  } finally {
    statusTimer = window.setTimeout(pollStatus, 2000)
  }
}

/** 等新进程的控制通道就绪后重取页面数据：外部直接编辑 storage.json 的情况也要能反映出来 */
async function refreshAfterRestart(): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((resolve) => window.setTimeout(resolve, 800))

    try {
      const response = await fetch(accountEndpoint('status'), { cache: 'no-store' })
      const status = (await response.json()) as ProcessStatus
      if (!status.running || !status.control) {
        continue
      }

      await Promise.all([load(), loadConfigJson()])
      // 名单是懒加载的：新进程的完成状态可能变了，先标记失效，等下次展开再取
      medalLoaded.value = false
      if (medalExpanded.value) {
        await loadMedals()
      }
      return
    } catch {
      // 控制台短暂不可用，继续等下一轮
    }
  }
}

async function restartProgram(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '会停止当前任务进程并重新启动：重新读取 data/storage.json 与 cookie.txt，全部任务从头运行。在途请求立即中断；控制台不下线，运行日志保持连续。',
      '重新启动任务',
      { type: 'warning', confirmButtonText: '重新启动', cancelButtonText: '取消' },
    )
  } catch {
    return
  }

  restarting.value = true

  try {
    const response = await fetch(accountEndpoint('restart'), { method: 'POST' })
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      throw new Error(data.error ?? `HTTP ${response.status}`)
    }

    ElMessage.success('已开始重新启动，进度见下方运行日志')
    void refreshAfterRestart()
  } catch (err) {
    ElMessage.error(`重新启动失败：${(err as Error).message}`)
  } finally {
    // 重启在控制台侧异步进行，留出一段时间避免连点；状态由既有的轮询循环更新
    window.setTimeout(() => {
      restarting.value = false
    }, 1500)
  }
}

onMounted(async () => {
  await loadAccounts()
  if (currentAccount.value) {
    await selectAccount(currentAccount.value, true)
  }
  void pollLogs()
  void pollStatus()
  void pollWatch()
})

onUnmounted(() => {
  window.clearTimeout(logTimer)
  window.clearTimeout(logReloadTimer)
  window.clearTimeout(statusTimer)
  window.clearTimeout(watchTimer)
  window.clearTimeout(paramSaveTimer)
})

/* ---------------- 观看直播进度 ---------------- */

const liveWatchInfo = ref<LiveWatchInfo | null>(null)
let watchTimer: number | undefined

const watchPercent = computed(() => {
  const info = liveWatchInfo.value
  if (!info || info.total <= 0) return 0
  return Math.min(100, Math.round((info.progress / info.total) * 100))
})

async function fetchWatch(): Promise<void> {
  const response = await fetch(accountEndpoint('watch'), { cache: 'no-store' })
  if (response.ok) {
    const info = (await response.json()) as Partial<LiveWatchInfo> | null
    // 空闲时控制通道把 null 折叠成空对象，按字段判定而不是按真值
    liveWatchInfo.value = info?.roomId != null ? (info as LiveWatchInfo) : null
  }
}

async function pollWatch(): Promise<void> {
  try {
    if (!document.hidden) {
      await fetchWatch()
    }
  } catch {
    // 控制台重启期间保留上一次数据
  } finally {
    watchTimer = window.setTimeout(pollWatch, 2000)
  }
}

/* ---------------- 粉丝勋章名单 ---------------- */

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

interface MedalListSnapshot {
  rows: MedalRow[]
  isWhiteList: boolean
  roomidList: number[]
  roomidList2: number[]
  status: string
}

const medalTableRef = ref<InstanceType<typeof ElTable>>()
const medalRows = ref<MedalRow[]>([])
const medalIsWhiteList = ref(false)
/** 正在编辑的名单：主名单（白名单 / 黑名单）或优先名单 */
const medalMode = ref<'list' | 'priority'>('list')
/** 两个名单的房间号，数组顺序即写入顺序 */
const medalListRoomids = ref<number[]>([])
const medalPriorityRoomids = ref<number[]>([])
const medalStatus = ref('')
const medalLoading = ref(false)
const medalSaving = ref(false)
/** 卡片默认收起：名单数据量较大，展开时才向后端取一次 */
const medalExpanded = ref(false)
/** 是否已成功取过名单，收起后再次展开不必重取 */
const medalLoaded = ref(false)

/** 收起时在标题旁显示概况，让用户不必展开也能知道名单规模 */
const medalSummary = computed(() => {
  if (medalLoading.value) {
    return '加载中…'
  }
  if (!medalLoaded.value) {
    return '点击加载'
  }
  return `黑白名单 ${medalListRoomids.value.length} · 优先名单 ${medalPriorityRoomids.value.length}`
})
const medalSearchText = ref('')
const medalFilter = ref<'all' | 'lighted' | 'unlighted' | 'checked' | 'unchecked'>('all')

const activeMedalRoomids = computed(() =>
  medalMode.value === 'priority' ? medalPriorityRoomids.value : medalListRoomids.value,
)

/** 已勾选的按名单顺序排在前面，其余保持勋章列表原顺序 */
const orderedMedalRows = computed(() => {
  const order = new Map(activeMedalRoomids.value.map((roomid, index) => [roomid, index]))
  return [...medalRows.value].sort((a, b) => {
    const left = order.get(a.roomid)
    const right = order.get(b.roomid)
    if (left !== undefined && right !== undefined) return left - right
    if (left !== undefined) return -1
    if (right !== undefined) return 1
    return 0
  })
})

const medalFilterActive = computed(
  () => medalSearchText.value.trim() !== '' || medalFilter.value !== 'all',
)

const filteredMedalRows = computed(() => {
  let rows = [...orderedMedalRows.value]

  const keyword = medalSearchText.value.trim().toLowerCase()
  if (keyword) {
    rows = rows.filter(
      (row) =>
        row.nick_name.toLowerCase().includes(keyword) ||
        row.medal_name.toLowerCase().includes(keyword) ||
        String(row.roomid).includes(keyword) ||
        String(row.uid).includes(keyword),
    )
  }

  const filter = medalFilter.value
  if (filter === 'lighted' || filter === 'unlighted') {
    rows = rows.filter((row) => row.is_lighted === (filter === 'lighted'))
  } else if (filter === 'checked' || filter === 'unchecked') {
    // 勾选状态随编辑实时变化：在「仅已勾选」下取消勾选后该行会立即移出显示
    const checked = new Set(activeMedalRoomids.value)
    rows = rows.filter((row) => checked.has(row.roomid) === (filter === 'checked'))
  }

  return rows
})

/** 保存防抖：连续勾选合并成一次请求 */
let medalSaveTimer = 0

function scheduleMedalSave(): void {
  window.clearTimeout(medalSaveTimer)
  medalSaveTimer = window.setTimeout(() => void saveMedals(), 300)
}

onUnmounted(() => window.clearTimeout(medalSaveTimer))

/**
 * 提交名单
 *
 * mode 缺省取当前编辑的名单；切换白名单开关时显式传 list，
 * 否则在优先名单下改开关会把主名单当成优先名单提交。
 */
async function saveMedals(mode: 'list' | 'priority' = medalMode.value): Promise<void> {
  medalSaving.value = true

  try {
    const roomids = mode === 'priority' ? medalPriorityRoomids.value : medalListRoomids.value
    const response = await fetch(accountEndpoint('medals'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode,
        isWhiteList: medalIsWhiteList.value,
        roomids,
      }),
    })

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      throw new Error(data.error ?? `HTTP ${response.status}`)
    }
  } catch (err) {
    ElMessage.error(`保存名单失败：${(err as Error).message}`)
    // 服务端没接受改动，重新读取以免页面与磁盘不一致
    await loadMedals()
  } finally {
    medalSaving.value = false
  }
}

function writeMedalRoomids(roomids: number[]): void {
  if (medalMode.value === 'priority') {
    medalPriorityRoomids.value = roomids
  } else {
    medalListRoomids.value = roomids
  }
  scheduleMedalSave()
}

/** 按当前名单勾选表格行，只处理显示中的行 */
function syncMedalSelection(): void {
  const checked = new Set(activeMedalRoomids.value)
  for (const row of filteredMedalRows.value) {
    medalTableRef.value?.toggleRowSelection(row, checked.has(row.roomid))
  }
}

async function loadMedals(): Promise<void> {
  medalLoading.value = true

  try {
    const response = await fetch(accountEndpoint('medals'), { cache: 'no-store' })
    const data = (await response.json()) as Partial<MedalListSnapshot> & { error?: string }

    if (!response.ok) {
      throw new Error(data.error ?? `HTTP ${response.status}`)
    }

    medalRows.value = data.rows ?? []
    medalIsWhiteList.value = data.isWhiteList ?? false
    medalListRoomids.value = data.roomidList ?? []
    medalPriorityRoomids.value = data.roomidList2 ?? []
    medalStatus.value = data.status ?? ''
    medalLoaded.value = true

    await nextTick()
    syncMedalSelection()
  } catch (err) {
    medalRows.value = []
    ElMessage.error(`读取粉丝勋章失败：${(err as Error).message}`)
  } finally {
    medalLoading.value = false
  }
}

/**
 * 展开/收起名单卡片
 *
 * 首次展开才取数据；表格用 v-if 重建，收起后再次展开需要把勾选状态补回去。
 * 读取失败时保持「未加载」，下次展开会重试。
 */
async function toggleMedalPanel(): Promise<void> {
  if (medalExpanded.value) {
    medalExpanded.value = false
    return
  }

  medalExpanded.value = true
  if (!medalLoaded.value) {
    await loadMedals()
    return
  }

  await nextTick()
  syncMedalSelection()
}

// 搜索/筛选后表格行会被替换，重新按名单勾选，避免勾选状态丢失
watch(filteredMedalRows, () => void nextTick(syncMedalSelection))

/**
 * 表格勾选变化
 *
 * 搜索/筛选隐藏的行保持原勾选状态，显示的行以本次选择为准；
 * 已勾选的保持原有写入顺序，新勾选的排在末尾。
 */
function handleMedalSelectionChange(rows: MedalRow[]): void {
  const visible = new Set(filteredMedalRows.value.map((row) => row.roomid))
  const selected = new Set(rows.map((row) => row.roomid))

  const roomids = activeMedalRoomids.value.filter(
    (roomid) => !visible.has(roomid) || selected.has(roomid),
  )
  const known = new Set(roomids)
  for (const row of medalRows.value) {
    if (selected.has(row.roomid) && !known.has(row.roomid)) {
      roomids.push(row.roomid)
      known.add(row.roomid)
    }
  }

  writeMedalRoomids(roomids)
}

/** 点击整行切换勾选；复选框与链接自己处理，不再重复切换 */
function handleMedalRowClick(row: MedalRow, _column: unknown, event: Event): void {
  const target = event.target as HTMLElement | null
  if (target?.closest('.el-checkbox, a, button')) return

  const roomids = [...activeMedalRoomids.value]
  const index = roomids.indexOf(row.roomid)
  if (index >= 0) {
    roomids.splice(index, 1)
    medalTableRef.value?.toggleRowSelection(row, false)
  } else {
    roomids.push(row.roomid)
    medalTableRef.value?.toggleRowSelection(row, true)
  }
  writeMedalRoomids(roomids)
}

/** 切换编辑目标：换了名单要按新名单重新勾选 */
async function switchMedalMode(mode: 'list' | 'priority'): Promise<void> {
  if (medalMode.value === mode) return
  medalMode.value = mode
  await nextTick()
  medalTableRef.value?.clearSelection()
  syncMedalSelection()
}

/** 白名单开关只作用于主名单，提交时显式指定 list */
function changeMedalWhiteList(): void {
  void saveMedals('list')
}

/** 按勋章列表的原始顺序重排当前名单 */
function resetMedalOrder(): void {
  const checked = new Set(activeMedalRoomids.value)
  writeMedalRoomids(
    medalRows.value.filter((row) => checked.has(row.roomid)).map((row) => row.roomid),
  )
  ElMessage.success('已按表格顺序重排')
}

/** 顺序调整窗口 */
const medalOrderVisible = ref(false)

/** 已勾选的行，按写入顺序排列；勋章数据里没有的用房间号顶替 */
const orderedCheckedRows = computed(() =>
  activeMedalRoomids.value.map((roomid, index) => {
    const row = medalRows.value.find((item) => item.roomid === roomid)
    return {
      roomid,
      index,
      nick_name: row?.nick_name ?? '',
      medal_name: row?.medal_name ?? '',
    }
  }),
)

/** 与相邻项交换位置；index 是名单里的下标 */
function moveMedalOrder(index: number, delta: number): void {
  const roomids = [...activeMedalRoomids.value]
  const target = index + delta
  if (target < 0 || target >= roomids.length) return
  ;[roomids[index], roomids[target]] = [roomids[target], roomids[index]]
  writeMedalRoomids(roomids)
}

/* ---------------- 手动点赞 ---------------- */

const likeTableRef = ref<InstanceType<typeof ElTable>>()
const likeCandidates = ref<LikeRoomCandidate[]>([])
const likeSelection = ref<LikeRoomCandidate[]>([])
const likeLoading = ref(false)
/** 今日已点赞次数与提示阈值 */
const todayLikes = ref(0)
const dailyLimit = ref(0)
/** 点赞名单的搜索关键字（昵称 / 粉丝勋章 / 房间号 / UID），只影响显示 */
const likeSearchText = ref('')
/** 点赞名单的筛选条件，只影响显示 */
const likeFilter = ref<'all' | 'lighted' | 'unlighted' | 'checked' | 'unchecked'>('all')
/** 搜索/筛选是否生效 */
const likeFilterActive = computed(
  () => likeSearchText.value.trim() !== '' || likeFilter.value !== 'all',
)
/** 搜索/筛选后的点赞候选 */
const filteredLikeCandidates = computed<LikeRoomCandidate[]>(() => {
  let rows = [...likeCandidates.value]
  const keyword = likeSearchText.value.trim().toLowerCase()

  if (keyword) {
    rows = rows.filter(
      (row) =>
        row.nick_name.toLowerCase().includes(keyword) ||
        row.medal_name.toLowerCase().includes(keyword) ||
        String(row.roomid).includes(keyword) ||
        String(row.uid).includes(keyword),
    )
  }
  if (likeFilter.value === 'lighted' || likeFilter.value === 'unlighted') {
    rows = rows.filter((row) => row.is_lighted === (likeFilter.value === 'lighted'))
  } else if (likeFilter.value === 'checked' || likeFilter.value === 'unchecked') {
    // 勾选状态实时变化：在「仅已勾选」下取消勾选后该行会立即移出显示
    const checked = new Set(likeSelection.value.map((row) => row.roomid))
    rows = rows.filter((row) => checked.has(row.roomid) === (likeFilter.value === 'checked'))
  }

  return rows
})
/** 点赞名单表格最大高度 */
const likeTableMaxHeight = Math.round(screen.height * 0.55)

/** 收集可点赞的直播间（服务端逐个探测直播状态与点赞进度，可能耗时较久） */
async function loadLikeCandidates(): Promise<void> {
  likeLoading.value = true
  likeSelection.value = []

  try {
    const response = await fetch(accountEndpoint('like'))
    const data = (await response.json()) as Partial<LikeCandidateSnapshot> & { error?: string }

    if (!response.ok) {
      throw new Error(data.error ?? `HTTP ${response.status}`)
    }

    likeCandidates.value = data.candidates ?? []
    todayLikes.value = data.todayLikes ?? 0
    dailyLimit.value = data.dailyLimit ?? 0

    if (likeCandidates.value.length === 0) {
      ElMessage.warning('没有可以点赞的直播间')
      return
    }

    // 默认顺序：默认勾选的排在前，同组内按勋章等级降序
    const defaultCheckedRoomids = new Set(
      likeCandidates.value.filter((row) => !row.reachFreeIntimacyLimit).map((row) => row.roomid),
    )
    likeCandidates.value.sort(
      (a, b) =>
        Number(defaultCheckedRoomids.has(b.roomid)) - Number(defaultCheckedRoomids.has(a.roomid)) ||
        b.medal_level - a.medal_level,
    )

    // 默认全选，用户再按需去掉不想点赞的房间；亲密度储蓄已满的默认不勾选
    likeSelection.value = likeCandidates.value.filter((row) => !row.reachFreeIntimacyLimit)
    await nextTick()
    syncLikeSelection()
  } catch (err) {
    likeCandidates.value = []
    ElMessage.error(`获取可点赞直播间失败：${(err as Error).message}`)
  } finally {
    likeLoading.value = false
  }
}

/** 「点赞30次」任务是否有可展示的进度（未点亮或任务信息缺失时为 false） */
function hasLikeProgress(row: LikeRoomCandidate): boolean {
  return typeof row.likeProgress === 'number' && (row.likeProgressTotal ?? 0) > 0
}

/** 点赞进度百分比，用于进度条 */
function likePercent(row: LikeRoomCandidate): number {
  const total = row.likeProgressTotal ?? 0
  if (!hasLikeProgress(row) || total <= 0) return 0
  return Math.min(100, Math.round(((row.likeProgress as number) / total) * 100))
}

/** B 站默认头像，头像加载失败时兜底 */
const NOFACE_AVATAR = '//i0.hdslb.com/bfs/face/member/noface.jpg'

/**
 * 头像地址：经控制台转发，只暴露同源地址
 *
 * B 站图床对来自本页面的 Referer 返回 403，也不给 CORS 头，浏览器直连取不到；
 * 控制台带上正常站点 Referer 取回并缓存，接口可能给的协议相对形式也在这里补全。
 */
function avatarUrl(row: { avatar: string }): string {
  const src = row.avatar
  if (!src) return ''
  const url = src.startsWith('//') ? `https:${src}` : src
  return `/api/avatar?url=${encodeURIComponent(url)}`
}

/**
 * 同步勾选
 *
 * 表格在数据变化时会清掉不可见行的选中状态，所以不能直接采用事件给出的选中数组：
 * 搜索/筛选隐藏的行保持原勾选，显示的行以本次选择为准。
 */
function handleLikeSelect(selection: LikeRoomCandidate[]): void {
  const visibleIds = new Set(filteredLikeCandidates.value.map((row) => row.roomid))
  const selectedIds = new Set(selection.map((row) => row.roomid))
  const roomids = likeSelection.value
    .map((row) => row.roomid)
    .filter((roomid) => !visibleIds.has(roomid) || selectedIds.has(roomid))
  const known = new Set(roomids)

  likeCandidates.value.forEach((row) => {
    if (selectedIds.has(row.roomid) && !known.has(row.roomid)) {
      roomids.push(row.roomid)
      known.add(row.roomid)
    }
  })

  const rowByRoomid = new Map(likeCandidates.value.map((row) => [row.roomid, row]))
  likeSelection.value = roomids
    .map((roomid) => rowByRoomid.get(roomid))
    .filter((row): row is LikeRoomCandidate => Boolean(row))
}

/** 把已勾选的直播间同步到表格，只处理显示中的行 */
function syncLikeSelection(): void {
  const checked = new Set(likeSelection.value.map((row) => row.roomid))
  filteredLikeCandidates.value.forEach((row) => {
    likeTableRef.value?.toggleRowSelection(row, checked.has(row.roomid))
  })
}

// 搜索/筛选后表格行会被替换，重新按已勾选列表恢复，避免勾选状态丢失
watch(filteredLikeCandidates, () => nextTick(syncLikeSelection))

/**
 * 点击整行切换勾选。
 *
 * 复选框自己会切换、链接要跳转，这两类目标不再重复处理，否则一次点击等于切换两次。
 */
function handleLikeRowClick(row: LikeRoomCandidate, _column: unknown, event: Event): void {
  const target = event.target as HTMLElement | null
  if (target?.closest('.el-checkbox, a, button')) return

  // 勾选状态以 likeSelection 为准，同时显式切换表格行，不依赖 select 事件回流
  const selected = likeSelection.value.some((item) => item.roomid === row.roomid)
  if (selected) {
    likeSelection.value = likeSelection.value.filter((item) => item.roomid !== row.roomid)
  } else {
    likeSelection.value = [...likeSelection.value, row]
  }
  likeTableRef.value?.toggleRowSelection(row, !selected)
}

/** 提交选中的直播间，服务端在后台逐个点赞 */
async function runLike(): Promise<void> {
  if (likeSelection.value.length === 0) {
    ElMessage.warning('请先勾选要点赞的直播间')
    return
  }

  try {
    const response = await fetch(accountEndpoint('like'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomids: likeSelection.value.map((row) => row.roomid) }),
    })
    const data = (await response.json()) as { error?: string }

    if (!response.ok) {
      throw new Error(data.error ?? `HTTP ${response.status}`)
    }

    ElMessage.success(`已开始为 ${likeSelection.value.length} 个直播间点赞，进度见运行日志`)
    likeCandidates.value = []
    likeSelection.value = []
  } catch (err) {
    ElMessage.error(`触发点赞失败：${(err as Error).message}`)
  }
}
</script>

<template>
  <div class="page">
    <el-alert v-if="accountError" :title="accountError" type="error" :closable="false" show-icon />

    <div class="account-bar">
      <el-tabs v-model="currentAccount" @tab-change="onAccountTabChange" class="account-tabs">
        <el-tab-pane
          v-for="account in accounts"
          :key="account.name"
          :label="account.name"
          :name="account.name"
        />
      </el-tabs>
      <div class="account-actions">
        <el-button size="small" @click="openAddAccount">新增账号</el-button>
        <el-button
          size="small"
          type="danger"
          plain
          :disabled="!currentAccount"
          @click="removeCurrentAccount"
        >
          删除当前
        </el-button>
      </div>
    </div>

    <header class="header">
      <div class="header-text">
        <h1>BLTH 配置</h1>
        <p class="hint">此处可调整任务开关、观看时长与少量开关型参数；其余任务参数（投币数量、弹幕列表、房间名单）在页面底部的「配置 JSON」中修改。改动即时生效；需要停止全部任务并按新配置从头重跑时，点右上角【重新启动任务】</p>
        <p class="hint process-status" :class="{ stopped: processStatus && !processStatus.running }">
          {{ statusText }}
        </p>
      </div>
      <el-button type="danger" plain :loading="restarting" @click="restartProgram">
        重新启动该账号
      </el-button>
    </header>

    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />

    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span class="group-name">日志</span>
          <span class="hint">全部等级都会记录；下方筛选只影响本页显示，默认隐藏 debug</span>
        </div>
      </template>

      <div class="row log-toolbar">
        <span class="task-hint">显示</span>
        <el-select
          v-model="logLevelFilter"
          multiple
          collapse-tags
          collapse-tags-tooltip
          size="small"
          placeholder="全部等级"
          style="width: 200px"
        >
          <el-option v-for="level in RECORD_LEVELS" :key="level" :label="level" :value="level" />
        </el-select>
        <el-select
          v-model="logModule"
          clearable
          size="small"
          placeholder="全部模块"
          style="width: 220px"
        >
          <el-option v-for="name in logModules" :key="name" :label="name" :value="name" />
        </el-select>
        <el-input
          v-model="logKeyword"
          size="small"
          clearable
          placeholder="关键词"
          class="log-keyword"
        />
        <el-switch v-model="logAutoScroll" size="small" active-text="自动滚动" />
        <el-button size="small" @click="toggleLogPause">{{ logPaused ? '继续' : '暂停' }}</el-button>
        <el-button size="small" @click="clearLogView">清空显示</el-button>
      </div>

      <div ref="logViewRef" class="log-view">
        <p v-if="logRecords.length === 0" class="log-empty">没有匹配的日志（debug 默认不显示）</p>
        <div v-for="record in logRecords" :key="record.seq" class="log-line">
          <span class="log-time">{{ formatClock(record.time) }}</span>
          <span class="log-level" :class="`lv-${record.level}`">{{ record.level }}</span>
          <span v-if="record.title" class="log-title">{{ record.title }}</span>
          <span class="log-text">{{ record.text }}</span>
        </div>
      </div>

      <p class="hint log-footer">
        日志在内存保留最近 1 小时（最多 {{ MAX_LOG_RECORDS }} 条），当前显示
        {{ logRecords.length }} 条；重启任务进程不会清空
      </p>
    </el-card>

    <el-card v-if="liveWatchInfo" shadow="never" class="card">
      <template #header>
        <span class="group-name">观看直播进度</span>
      </template>

      <p class="hint">
        正在观看：{{ liveWatchInfo.roomName }}（{{ liveWatchInfo.roomId }}）· 第
        {{ liveWatchInfo.roomIndex }}/{{ liveWatchInfo.totalRooms }} 个
      </p>

      <el-progress
        :percentage="watchPercent"
        :stroke-width="12"
        :show-text="false"
        style="margin-top: 8px"
      />

      <p class="hint" style="margin-top: 8px">
        进度 {{ liveWatchInfo.progress }} / {{ liveWatchInfo.total }}
      </p>
    </el-card>

    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <button type="button" class="card-toggle" @click="toggleMedalPanel">
            <span class="caret" :class="{ open: medalExpanded }">▸</span>
            <span class="group-name">粉丝勋章名单</span>
            <span v-if="!medalExpanded" class="task-hint">{{ medalSummary }}</span>
          </button>
          <div class="card-actions">
            <span v-if="medalSaving" class="task-hint">保存中…</span>
          </div>
        </div>
      </template>

      <div v-if="medalExpanded">
        <p class="hint">
          名单决定哪些直播间参与【点亮熄灭勋章】与【观看直播】。勾选即写入配置，改动立即落盘生效。
        </p>

        <div class="row">
          <el-switch
            v-model="medalIsWhiteList"
            active-text="白名单"
            inactive-text="黑名单"
            @change="changeMedalWhiteList"
          />
          <el-button
            :type="medalMode === 'list' ? 'primary' : ''"
            :loading="medalLoading"
            @click="switchMedalMode('list')"
          >
            黑白名单（{{ medalListRoomids.length }}）
          </el-button>
          <el-button
            :type="medalMode === 'priority' ? 'primary' : ''"
            :loading="medalLoading"
            @click="switchMedalMode('priority')"
          >
            优先名单（{{ medalPriorityRoomids.length }}）
          </el-button>
        </div>

        <p class="hint">
          {{
            medalMode === 'priority'
              ? '优先名单：这些直播间排在勋章任务队列前面先执行。'
              : medalIsWhiteList
                ? '白名单：只对勾选的直播间执行勋章任务。'
                : '黑名单：勾选的直播间不参与勋章任务。'
          }}
        </p>

        <div class="row">
          <el-input
            v-model="medalSearchText"
            class="medal-search"
            placeholder="搜索昵称 / 粉丝勋章 / 房间号 / UID"
            clearable
          />
          <el-select v-model="medalFilter" style="width: 160px">
            <el-option label="全部" value="all" />
            <el-option-group label="点亮状态">
              <el-option label="仅已点亮" value="lighted" />
              <el-option label="仅未点亮" value="unlighted" />
            </el-option-group>
            <el-option-group label="勾选状态">
              <el-option label="仅已勾选" value="checked" />
              <el-option label="仅未勾选" value="unchecked" />
            </el-option-group>
          </el-select>
          <el-button @click="resetMedalOrder">恢复表格顺序</el-button>
          <el-button @click="medalOrderVisible = true">调整顺序</el-button>
        </div>

        <p v-if="!medalLoading && medalRows.length === 0" class="hint">
          还没有粉丝勋章数据{{
            medalStatus === 'error'
              ? '（获取失败，请检查 cookie 与运行日志）'
              : '，请稍后刷新或查看运行日志'
          }}。
        </p>

        <el-table
          v-else
          ref="medalTableRef"
          v-loading="medalLoading"
          :data="filteredMedalRows"
          :row-key="(row: MedalRow) => String(row.roomid)"
          size="small"
          :max-height="420"
          class="like-table"
          :empty-text="medalFilterActive ? '没有匹配的粉丝勋章' : '没有粉丝勋章'"
          @select="handleMedalSelectionChange"
          @select-all="handleMedalSelectionChange"
          @row-click="handleMedalRowClick"
        >
          <el-table-column type="selection" width="45" />
          <el-table-column label="主播" min-width="160">
            <template #default="scope">
              <div class="anchor-cell">
                <el-avatar :size="24" :src="avatarUrl(scope.row)" />
                <span class="anchor-name">{{ scope.row.nick_name }}</span>
                <el-tag v-if="scope.row.is_canceled" type="info" size="small" effect="plain">
                  已注销
                </el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="medal_name" label="粉丝勋章" min-width="100" />
          <el-table-column prop="medal_level" label="等级" width="70" align="center" />
          <el-table-column label="点亮" width="90" align="center">
            <template #default="scope">
              <el-tag :type="scope.row.is_lighted ? 'success' : 'info'" size="small" effect="plain">
                {{ scope.row.is_lighted ? '已点亮' : '未点亮' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="房间号" width="110">
            <template #default="scope">
              <a
                class="link"
                :href="`https://live.bilibili.com/${scope.row.roomid}`"
                target="_blank"
                rel="noreferrer"
                @click.stop
              >
                {{ scope.row.roomid }}
              </a>
            </template>
          </el-table-column>
          <el-table-column label="UID" width="110">
            <template #default="scope">
              <a
                class="link"
                :href="`https://space.bilibili.com/${scope.row.uid}`"
                target="_blank"
                rel="noreferrer"
                @click.stop
              >
                {{ scope.row.uid }}
              </a>
            </template>
          </el-table-column>
        </el-table>

        <p v-if="medalRows.length > 0" class="hint">
          已选 {{ activeMedalRoomids.length }} 个；写入顺序即任务执行顺序，新勾选的排在末尾。
        </p>
      </div>
    </el-card>

    <el-dialog
      v-model="medalOrderVisible"
      title="调整写入顺序"
      width="460px"
      :lock-scroll="false"
    >
      <p class="hint">顺序决定任务执行的先后，新勾选的排在末尾。</p>
      <p v-if="orderedCheckedRows.length === 0" class="hint">还没有勾选任何直播间。</p>
      <div v-for="item in orderedCheckedRows" :key="item.roomid" class="order-item">
        <span class="order-index">{{ item.index + 1 }}</span>
        <span class="order-name">{{ item.nick_name || item.roomid }}</span>
        <span class="task-hint">{{ item.roomid }}</span>
        <el-button
          size="small"
          :disabled="item.index === 0"
          @click="moveMedalOrder(item.index, -1)"
        >
          上移
        </el-button>
        <el-button
          size="small"
          :disabled="item.index === orderedCheckedRows.length - 1"
          @click="moveMedalOrder(item.index, 1)"
        >
          下移
        </el-button>
      </div>
    </el-dialog>

    <el-card shadow="never" class="card">
      <template #header>
        <span class="group-name">点赞（手动 / 每日自动）</span>
      </template>

      <p class="hint">
        先获取可点赞的直播间，勾选后开始点赞，执行进度见运行日志。此外每天 23:30
        会自动按默认勾选规则执行一次点赞（亲密度储蓄已满的勋章不勾选）。
      </p>

      <div class="row">
        <el-input
          v-model="likeSearchText"
          class="like-search"
          placeholder="搜索昵称 / 粉丝勋章 / 房间号 / UID"
          clearable
        />
        <el-select v-model="likeFilter" style="width: 160px">
          <el-option label="全部" value="all" />
          <el-option-group label="点亮状态">
            <el-option label="仅已点亮" value="lighted" />
            <el-option label="仅未点亮" value="unlighted" />
          </el-option-group>
          <el-option-group label="勾选状态">
            <el-option label="仅已勾选" value="checked" />
            <el-option label="仅未勾选" value="unchecked" />
          </el-option-group>
        </el-select>
        <el-button :loading="likeLoading" @click="loadLikeCandidates">获取可点赞直播间</el-button>
      </div>

      <p v-if="dailyLimit > 0" class="hint">
        今日已点亮勋章点赞 {{ todayLikes }} 次（提示阈值 {{ dailyLimit }}，未点亮勋章的点赞不计数）。
        亲密度储蓄已满的勋章标记为【已满】并默认不勾选，需要时手动勾上。
      </p>

      <el-table
        v-if="likeCandidates.length > 0"
        ref="likeTableRef"
        :data="filteredLikeCandidates"
        row-key="roomid"
        :max-height="likeTableMaxHeight"
        class="like-table"
        :empty-text="likeFilterActive ? '没有匹配的直播间' : '没有可点赞的直播间'"
        @select="handleLikeSelect"
        @select-all="handleLikeSelect"
        @row-click="handleLikeRowClick"
      >
        <el-table-column type="selection" align="center" width="60" />
        <el-table-column label="头像" width="90">
          <template #default="scope">
            <div class="avatar-wrap">
              <el-image :src="avatarUrl(scope.row)" loading="lazy" class="avatar">
                <template #error>
                  <el-image :src="avatarUrl({ avatar: NOFACE_AVATAR })" class="avatar" />
                </template>
              </el-image>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="昵称" min-width="110">
          <template #default="scope">
            <span>{{ scope.row.nick_name }}</span>
            <el-tag
              v-if="scope.row.nick_name === CANCELLED_NICK_NAME"
              type="info"
              size="small"
              effect="plain"
              class="cancelled-tag"
            >
              已注销
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="medal_name" label="粉丝勋章" min-width="100" />
        <el-table-column prop="medal_level" label="等级" width="70" align="center" />
        <el-table-column label="点亮状态" width="90" align="center">
          <template #default="scope">
            <el-tag :type="scope.row.is_lighted ? 'success' : 'info'" size="small" effect="plain">
              {{ scope.row.is_lighted ? '已点亮' : '未点亮' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="亲密度储蓄" width="120" align="center">
          <template #default="scope">
            <el-tag
              v-if="scope.row.reachFreeIntimacyLimit"
              type="warning"
              size="small"
              effect="plain"
            >
              已满 {{ scope.row.freeIntimacy }}
            </el-tag>
            <el-text
              v-else-if="typeof scope.row.freeIntimacy === 'number'"
              type="info"
              size="small"
            >
              {{ scope.row.freeIntimacy }}
            </el-text>
            <el-text v-else type="info">—</el-text>
          </template>
        </el-table-column>
        <el-table-column label="点赞进度" width="150">
          <template #default="scope">
            <template v-if="hasLikeProgress(scope.row)">
              <el-progress
                :percentage="likePercent(scope.row)"
                :stroke-width="6"
                :show-text="false"
              />
              <el-text size="small">
                {{ scope.row.likeProgress }} / {{ scope.row.likeProgressTotal }}
              </el-text>
            </template>
            <el-text v-else type="info">—</el-text>
          </template>
        </el-table-column>
        <el-table-column label="房间号" width="120">
          <template #default="scope">
            <el-link
              :href="`https://live.bilibili.com/${scope.row.roomid}`"
              rel="noreferrer"
              type="primary"
              target="_blank"
              @click.stop
            >
              {{ scope.row.roomid }}
            </el-link>
          </template>
        </el-table-column>
        <el-table-column label="UID" width="120">
          <template #default="scope">
            <el-link
              :href="`https://space.bilibili.com/${scope.row.uid}`"
              rel="noreferrer"
              type="primary"
              target="_blank"
              @click.stop
            >
              {{ scope.row.uid }}
            </el-link>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="likeCandidates.length > 0" class="row">
        <el-button type="primary" :disabled="likeSelection.length === 0" @click="runLike">
          开始点赞（已选 {{ likeSelection.length }}）
        </el-button>
      </div>
    </el-card>

    <el-card v-for="group in groups" :key="group.name" shadow="never" class="card">
      <template #header>
        <span class="group-name">{{ group.name }}</span>
      </template>

      <template v-for="task in group.tasks" :key="task.id">
        <div class="row" :class="{ sub: task.sub }">
          <el-switch
            v-model="task.enabled"
            :loading="saving"
            :disabled="isDisabled(task)"
            @change="save"
          />
          <span class="label">{{ task.label }}</span>
          <span v-if="task.hint" class="task-hint">{{ task.hint }}</span>
        </div>

        <div
          v-for="param in paramsAfter(group.name, task.id)"
          :key="param.id"
          class="row param-row"
        >
          <span class="label">{{ param.label }}</span>
          <el-input-number
            v-model="param.value"
            size="small"
            class="param-input"
            :min="param.min"
            :max="param.max"
            :precision="0"
            :controls="false"
            :value-on-clear="param.min"
            @change="scheduleParamSave"
          />
          <span class="param-unit">{{ param.unit }}</span>
          <span v-if="paramSaving" class="task-hint">保存中…</span>
          <span v-if="param.hint" class="task-hint">{{ param.hint }}</span>
        </div>
      </template>
    </el-card>

    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span class="group-name">配置 JSON</span>
          <el-button size="small" :loading="configJsonLoading" @click="loadConfigJson">
            重新读取
          </el-button>
        </div>
      </template>

      <p class="hint">
        对应 data/storage.json 中的 modules，保存后立即生效并落盘。下划线开头的是运行状态（完成时间、点赞计数等），一般不用改。
      </p>

      <el-input
        v-model="configJson"
        type="textarea"
        :rows="18"
        spellcheck="false"
        class="config-json"
        @input="configJsonError = ''"
      />

      <p v-if="configJsonError" class="json-error">{{ configJsonError }}</p>

      <div class="row">
        <el-button type="primary" :loading="configJsonSaving" @click="saveConfigJson">保存</el-button>
        <el-button @click="formatConfigJson">格式化</el-button>
      </div>
    </el-card>

    <p class="footer">开关变更会立即写入配置；重新打开的任务会马上运行一次，今天已完成的任务只会重新排期，不会重复执行。配置由任务进程落盘，重启后会重新读取。每个账号有独立的 cookie 与数据目录（data/accounts/&lt;账号名&gt;/），可单独重启、互不影响。</p>

    <el-dialog v-model="addAccountVisible" title="新增账号" width="480px" :lock-scroll="false">
      <p class="hint">
        账号数据存放在 data/accounts/&lt;账号名&gt;/（含 cookie.txt 与 storage.json）。cookie
        留空时任务进程会提示未登录，可稍后把 cookie 粘贴到该目录的 cookie.txt 中再重启。
      </p>
      <el-form label-width="70px" style="margin-top: 12px">
        <el-form-item label="账号名">
          <el-input v-model="addAccountName" placeholder="如：小号A" clearable />
        </el-form-item>
        <el-form-item label="Cookie">
          <el-input
            v-model="addAccountCookie"
            type="textarea"
            :rows="6"
            spellcheck="false"
            placeholder="可选：粘贴该账号的 cookie 文本；留空则需自行写入 cookie 文件"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addAccountVisible = false">取消</el-button>
        <el-button type="primary" :loading="addAccountSaving" @click="createAccount">
          新增并启动
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page {
  max-width: 960px;
  margin: 0 auto;
  padding: 28px 16px 48px;
}

.account-bar {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.account-tabs {
  flex: 1;
  min-width: 0;
}

.account-tabs :deep(.el-tabs__header) {
  margin-bottom: 8px;
}

.account-actions {
  display: flex;
  gap: 8px;
  flex: none;
}

.header {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  justify-content: space-between;
}

.header h1 {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 500;
}

.card-header {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}

.card-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* 标题整体可点：点击区域不只是那个小三角 */
.card-toggle {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
  background: none;
  border: none;
}

.caret {
  display: inline-block;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  transition: transform 0.15s;
}

.caret.open {
  transform: rotate(90deg);
}

.hint {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.7;
}

.card {
  margin-top: 16px;
}

.process-status {
  margin-top: 8px;
  font-weight: 500;
}

.process-status.stopped {
  color: var(--el-color-danger);
}

.group-name {
  font-weight: 500;
}

.row {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
  padding: 5px 0;
}

.row.sub {
  padding-left: 28px;
}

/* 数值参数没有开关，缩进到子项所在列，视觉上归属上方的任务 */
.param-row {
  padding-left: 28px;
}

.param-input {
  width: 92px;
}

.param-unit {
  font-size: 13px;
}

.task-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.like-table {
  margin-top: 12px;
}

/* small 尺寸默认只有 4px 上下内边距，行挨得太紧；勋章名单表格放宽 */
.like-table.el-table--small :deep(.el-table__cell) {
  padding: 8px 0;
}

.like-table :deep(.el-table__row) {
  cursor: pointer;
}

.avatar-wrap {
  width: 80px;
  height: 80px;
}

.avatar {
  width: 80px;
  height: 80px;
  overflow: hidden;
  border-radius: 4px;
}

.cancelled-tag {
  margin-left: 4px;
}

.anchor-cell {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}

.anchor-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link {
  color: var(--el-color-primary);
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}

.medal-search,
.like-search {
  flex: 1;
  min-width: 200px;
}

.order-item {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 3px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.order-index {
  width: 28px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.order-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-toolbar {
  margin-top: 8px;
}

.log-keyword {
  flex: 1;
  min-width: 160px;
}

.log-view {
  height: 320px;
  margin-top: 8px;
  padding: 8px 10px;
  overflow-y: auto;
  font-family: ui-monospace, sfmono-regular, menlo, consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
}

.log-line {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.log-time {
  flex: none;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.log-level {
  flex: none;
  width: 44px;
  text-transform: uppercase;
}

.log-title {
  flex: none;
  color: var(--el-text-color-secondary);
}

.log-text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-empty {
  margin: 0;
  color: var(--el-text-color-secondary);
}

.log-footer {
  margin-top: 8px;
}

.lv-debug {
  color: var(--el-text-color-placeholder);
}

.lv-info {
  color: var(--el-color-primary);
}

.lv-warn {
  color: var(--el-color-warning);
}

.lv-error {
  color: var(--el-color-danger);
}

.config-json {
  margin-top: 8px;
}

.config-json :deep(.el-textarea__inner) {
  font-family: ui-monospace, sfmono-regular, menlo, consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
}

.json-error {
  margin: 8px 0 0;
  color: var(--el-color-danger);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.label {
  font-size: 14px;
}

.footer {
  margin-top: 20px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.7;
}
</style>
