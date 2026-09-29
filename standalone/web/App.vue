<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'

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
  max-width: 640px;
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
