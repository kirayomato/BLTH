<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElTable } from 'element-plus'
import type {
  LikeCandidateSnapshot,
  LikeRoomCandidate,
} from '@/modules/dailyTasks/liveTasks/medalTasks/types'

interface TaskView {
  id: string
  group: string
  label: string
  enabled: boolean
  hint?: string
  sub?: boolean
  parent?: string
}

const tasks = ref<TaskView[]>([])
const saving = ref(false)
const error = ref('')

const logLevels = [
  { value: 'debug', label: 'Debug（最详细）' },
  { value: 'info', label: 'Info（默认）' },
  { value: 'warn', label: 'Warn（仅警告与错误）' },
  { value: 'error', label: 'Error（仅错误）' },
  { value: 'none', label: '关闭（不输出）' },
]
const logLevel = ref('info')
const logSaving = ref(false)

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

async function load(): Promise<void> {
  try {
    const response = await fetch('/api/tasks')
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const data = (await response.json()) as { tasks: TaskView[] }
    tasks.value = data.tasks
    error.value = ''
  } catch (err) {
    error.value = `读取配置失败：${(err as Error).message}`
  }
}

async function save(): Promise<void> {
  saving.value = true

  try {
    const response = await fetch('/api/tasks', {
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

async function loadLogLevel(): Promise<void> {
  try {
    const response = await fetch('/api/config')
    if (!response.ok) {
      return
    }
    const data = (await response.json()) as { logLevel: string; logFile?: string }
    logLevel.value = data.logLevel
    if (data.logFile) {
      logFilePath.value = data.logFile
    }
  } catch {
    // 忽略，使用默认值
  }
}

async function saveLogLevel(): Promise<void> {
  logSaving.value = true

  try {
    const response = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logLevel: logLevel.value }),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    ElMessage.success('日志等级已更新')
  } catch (err) {
    ElMessage.error(`保存失败：${(err as Error).message}`)
    await loadLogLevel()
  } finally {
    logSaving.value = false
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

/** 页面保留的记录上限，与服务端缓冲一致 */
const MAX_LOG_RECORDS = 1000

const logRecords = ref<LogRecord[]>([])
const logSession = ref('')
const logLevelFilter = ref<RecordLevel[]>([...RECORD_LEVELS])
const logModule = ref<string>()
const logKeyword = ref('')
const logAutoScroll = ref(true)
const logPaused = ref(false)
const logFilePath = ref('data/blth.log')
const logViewRef = ref<HTMLElement>()

/** 已拉取到的最新序号；进程重启后由会话标识变化触发重取 */
let logLastSeq = 0
let logTimer: number | undefined

const logModules = computed(() => {
  const names = new Set<string>()

  for (const record of logRecords.value) {
    if (record.title) {
      names.add(record.title)
    }
  }

  return [...names].sort()
})

const filteredLogs = computed(() => {
  const keyword = logKeyword.value.trim().toLowerCase()
  const module = logModule.value

  return logRecords.value.filter((record) => {
    if (!logLevelFilter.value.includes(record.level)) {
      return false
    }
    if (module && record.title !== module) {
      return false
    }
    if (keyword && !`${record.title} ${record.text}`.toLowerCase().includes(keyword)) {
      return false
    }
    return true
  })
})

async function fetchLogs(after: number): Promise<void> {
  const response = await fetch(`/api/logs?after=${after}`, { cache: 'no-store' })
  if (!response.ok) {
    return
  }

  const data = (await response.json()) as { session: string; records: LogRecord[] }

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

  if (data.records.length === 0) {
    return
  }

  logRecords.value.push(...data.records)
  if (logRecords.value.length > MAX_LOG_RECORDS) {
    logRecords.value.splice(0, logRecords.value.length - MAX_LOG_RECORDS)
  }

  logLastSeq = data.records[data.records.length - 1].seq
  void scrollLogToBottom()
}

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
    const response = await fetch('/api/modules', { cache: 'no-store' })
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
    const response = await fetch('/api/modules', {
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

onMounted(() => {
  load()
  loadLogLevel()
  loadConfigJson()
  void pollLogs()
})

onUnmounted(() => {
  window.clearTimeout(logTimer)
})

/* ---------------- 手动点赞 ---------------- */

const likeTableRef = ref<InstanceType<typeof ElTable>>()
const likeCandidates = ref<LikeRoomCandidate[]>([])
const likeSelection = ref<LikeRoomCandidate[]>([])
const likeLoading = ref(false)
/** 今日已点赞次数与提示阈值 */
const todayLikes = ref(0)
const dailyLimit = ref(0)

/** 收集可点赞的直播间（服务端逐个探测直播状态与点赞进度，可能耗时较久） */
async function loadLikeCandidates(): Promise<void> {
  likeLoading.value = true
  likeSelection.value = []

  try {
    const response = await fetch('/api/like')
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
    await nextTick()
    likeCandidates.value
      .filter((row) => !row.reachFreeIntimacyLimit)
      .forEach((row) => {
        likeTableRef.value?.toggleRowSelection(row, true)
      })
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

function handleLikeSelectionChange(rows: LikeRoomCandidate[]): void {
  likeSelection.value = rows
}

/** 提交选中的直播间，服务端在后台逐个点赞 */
async function runLike(): Promise<void> {
  if (likeSelection.value.length === 0) {
    ElMessage.warning('请先勾选要点赞的直播间')
    return
  }

  try {
    const response = await fetch('/api/like', {
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
    <header class="header">
      <div class="header-text">
        <h1>BLTH 配置</h1>
        <p class="hint">此处可调整任务开关与少量开关型参数；其余任务参数（投币数量、观看时长、弹幕列表、房间名单）在页面底部的「配置 JSON」中修改</p>
      </div>
    </header>

    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />

    <el-card shadow="never" class="card">
      <template #header>
        <div class="card-header">
          <span class="group-name">日志</span>
          <span class="hint">等级同时决定终端输出与 {{ logFilePath }} 的写入</span>
        </div>
      </template>

      <div class="row">
        <span class="label">日志等级</span>
        <el-select v-model="logLevel" :loading="logSaving" style="width: 220px" @change="saveLogLevel">
          <el-option v-for="lv in logLevels" :key="lv.value" :label="lv.label" :value="lv.value" />
        </el-select>
      </div>

      <div class="row log-toolbar">
        <el-select
          v-model="logLevelFilter"
          multiple
          collapse-tags
          collapse-tags-tooltip
          size="small"
          placeholder="日志等级"
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
        <p v-if="filteredLogs.length === 0" class="log-empty">没有匹配的日志</p>
        <div v-for="record in filteredLogs" :key="record.seq" class="log-line">
          <span class="log-time">{{ formatClock(record.time) }}</span>
          <span class="log-level" :class="`lv-${record.level}`">{{ record.level }}</span>
          <span v-if="record.title" class="log-title">{{ record.title }}</span>
          <span class="log-text">{{ record.text }}</span>
        </div>
      </div>

      <p class="hint log-footer">
        内存保留最近 {{ MAX_LOG_RECORDS }} 条，当前显示 {{ filteredLogs.length }} 条
      </p>
    </el-card>

    <el-card shadow="never" class="card">
      <template #header>
        <span class="group-name">点赞（手动 / 每日自动）</span>
      </template>

      <p class="hint">
        先获取可点赞的直播间，勾选后开始点赞，执行进度见运行日志。此外每天 23:30
        会自动按默认勾选规则执行一次点赞（亲密度储蓄已满的勋章不勾选）。
      </p>

      <div class="row">
        <el-button :loading="likeLoading" @click="loadLikeCandidates">获取可点赞直播间</el-button>
        <span v-if="dailyLimit > 0" class="label">
          今日已点亮勋章点赞 {{ todayLikes }} 次（提示阈值 {{ dailyLimit }}，未点亮勋章的点赞不计数）
        </span>
      </div>

      <el-table
        v-if="likeCandidates.length > 0"
        ref="likeTableRef"
        :data="likeCandidates"
        row-key="roomid"
        size="small"
        :max-height="360"
        class="like-table"
        @selection-change="handleLikeSelectionChange"
      >
        <el-table-column type="selection" width="45" />
        <el-table-column prop="nick_name" label="昵称" min-width="100" />
        <el-table-column prop="medal_name" label="粉丝勋章" min-width="90" />
        <el-table-column prop="medal_level" label="等级" width="60" align="center" />
        <el-table-column label="点亮" width="80" align="center">
          <template #default="scope">{{ scope.row.is_lighted ? '已点亮' : '未点亮' }}</template>
        </el-table-column>
        <el-table-column label="亲密度" width="90" align="center">
          <template #default="scope">
            <el-tag
              v-if="scope.row.reachFreeIntimacyLimit"
              type="warning"
              size="small"
              effect="plain"
            >
              已满 {{ scope.row.freeIntimacy }}
            </el-tag>
            <span v-else-if="typeof scope.row.freeIntimacy === 'number'">
              {{ scope.row.freeIntimacy }}
            </span>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="点赞进度" width="140">
          <template #default="scope">
            <template v-if="hasLikeProgress(scope.row)">
              <el-progress
                :percentage="likePercent(scope.row)"
                :stroke-width="6"
                :show-text="false"
              />
              <span class="progress-text">
                {{ scope.row.likeProgress }} / {{ scope.row.likeProgressTotal }}
              </span>
            </template>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column prop="roomid" label="房间号" width="100" />
      </el-table>

      <div v-if="likeCandidates.length > 0" class="row">
        <el-button type="primary" @click="runLike">
          开始点赞（已选 {{ likeSelection.length }}）
        </el-button>
      </div>
    </el-card>

    <el-card v-for="group in groups" :key="group.name" shadow="never" class="card">
      <template #header>
        <span class="group-name">{{ group.name }}</span>
      </template>

      <div
        v-for="task in group.tasks"
        :key="task.id"
        class="row"
        :class="{ sub: task.sub }"
      >
        <el-switch
          v-model="task.enabled"
          :loading="saving"
          :disabled="isDisabled(task)"
          @change="save"
        />
        <span class="label">{{ task.label }}</span>
        <span v-if="task.hint" class="task-hint">{{ task.hint }}</span>
      </div>
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

    <p class="footer">开关变更会立即写入配置；新启用的任务若今天尚未完成，会马上运行一次。</p>
  </div>
</template>

<style scoped>
.page {
  max-width: 960px;
  margin: 0 auto;
  padding: 28px 16px 48px;
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

.hint {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  line-height: 1.7;
}

.card {
  margin-top: 16px;
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

.task-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.like-table {
  margin-top: 12px;
}

.progress-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
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
