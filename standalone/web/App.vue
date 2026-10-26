<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
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
    const data = (await response.json()) as { logLevel: string }
    logLevel.value = data.logLevel
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

onMounted(() => {
  load()
  loadLogLevel()
})

/* ---------------- 手动点赞 ---------------- */

const likeTableRef = ref<InstanceType<typeof ElTable>>()
const likeCandidates = ref<LikeRoomCandidate[]>([])
const likeSelection = ref<LikeRoomCandidate[]>([])
const likeLoading = ref(false)
/** 今日已点赞次数与每日上限 */
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

    // 默认全选，用户再按需去掉不想点赞的房间
    await nextTick()
    likeCandidates.value.forEach((row) => {
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
      <h1>BLTH 配置</h1>
      <p class="hint">此处只调整任务开关；任务参数（投币数量、观看时长、弹幕列表、房间名单）请编辑 data/storage.json</p>
    </header>

    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />

    <el-card shadow="never" class="card">
      <template #header>
        <span class="group-name">日志</span>
      </template>

      <div class="row">
        <span class="label">日志等级</span>
        <el-select v-model="logLevel" :loading="logSaving" style="width: 220px" @change="saveLogLevel">
          <el-option v-for="lv in logLevels" :key="lv.value" :label="lv.label" :value="lv.value" />
        </el-select>
      </div>
    </el-card>

    <el-card shadow="never" class="card">
      <template #header>
        <span class="group-name">点赞（手动）</span>
      </template>

      <p class="hint">
        点赞任务不再自动运行：先获取可点赞的直播间，勾选后开始点赞，执行进度见运行日志。
      </p>

      <div class="row">
        <el-button :loading="likeLoading" @click="loadLikeCandidates">获取可点赞直播间</el-button>
        <span v-if="dailyLimit > 0" class="label">
          今日已点亮勋章点赞 {{ todayLikes }} 次（上限 {{ dailyLimit }}，未点亮勋章的点赞不计数）
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
      </div>
    </el-card>

    <p class="footer">开关变更会立即写入配置；新启用的任务若今天尚未完成，会马上运行一次。</p>
  </div>
</template>

<style scoped>
.page {
  max-width: 760px;
  margin: 0 auto;
  padding: 28px 16px 48px;
}

.header h1 {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 500;
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
  padding: 5px 0;
}

.row.sub {
  padding-left: 28px;
}

.like-table {
  margin-top: 12px;
}

.progress-text {
  font-size: 12px;
  color: var(--el-text-color-secondary);
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
