<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useModuleStore, useBiliStore, useUIStore } from '@/stores'
import { Check, Edit, Delete } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox, ElTable } from 'element-plus'
import helpInfo from '@/library/help-info'
import { VueDraggable } from 'vue-draggable-plus'
import { arrayToMap } from '@/library/utils'
import type LightTask from '@/modules/dailyTasks/liveTasks/medalTasks/lightTask'

interface MedalRow {
  avatar: string
  nick_name: string
  medal_name: string
  medal_level: number
  roomid: number
  /** 粉丝勋章是否已点亮 */
  is_lighted: boolean
  /** 亲密度储蓄值，仅点赞流程收集过 */
  freeIntimacy?: number | null
  /** 亲密度储蓄是否已满，仅点赞流程收集过 */
  reachFreeIntimacyLimit?: boolean
  /** 「点赞30次」任务进度，仅点赞流程收集过 */
  likeProgress?: number | null
  /** 「点赞30次」任务进度上限，仅点赞流程收集过 */
  likeProgressTotal?: number | null
}

const moduleStore = useModuleStore()
const biliStore = useBiliStore()
const uiStore = useUIStore()

const medalTableMaxHeight = screen.height * 0.55
const danmuTableMaxHeight = screen.height * 0.5

const config = moduleStore.moduleConfig.DailyTasks.LiveTasks
const status = moduleStore.moduleStatus.DailyTasks.LiveTasks
const reset = moduleStore.moduleReset.DailyTasks.LiveTasks

const medalDanmuPanelVisible = ref<boolean>(false)
const danmuTableData = computed(() =>
  config.medalTasks.light.danmuList.map((danmu) => {
    return { content: danmu }
  }),
)

const handleEditDanmu = (index: number, row: { content: string }) => {
  ElMessageBox.prompt('请输入弹幕内容', '修改弹幕', {
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    inputPattern: /^.{1,30}$/,
    inputErrorMessage: '弹幕内容不得为空且长度不能超过30',
    inputValue: row.content,
    lockScroll: false,
  })
    .then(({ value }) => {
      config.medalTasks.light.danmuList[index] = value
    })
    .catch(() => {})
}

const handleDeleteDanmu = (index: number) => {
  if (config.medalTasks.light.danmuList.length === 1) {
    ElMessage.warning({
      message: '至少要有一条弹幕',
      appendTo: '.el-dialog',
    })
    return
  }
  config.medalTasks.light.danmuList.splice(index, 1)
}

const handleAddDanmu = () => {
  ElMessageBox.prompt('请输入新增的弹幕内容', '新增弹幕', {
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    inputPattern: /^.{1,30}$/,
    inputErrorMessage: '弹幕内容不得为空且长度不能超过30',
    lockScroll: false,
  })
    .then(({ value }) => {
      config.medalTasks.light.danmuList.push(value)
    })
    .catch(() => {})
}

const medalInfoPanelVisible = ref<boolean>(false)
/** 名单窗口的用途：编辑黑白名单 / 选择要执行点赞的直播间（点赞复用同一个窗口） */
const medalInfoPanelMode = ref<'list' | 'like'>('list')
const isLikeMode = computed(() => medalInfoPanelMode.value === 'like')

const medalInfoTableData = computed({
  get() {
    const medals = biliStore.filteredFansMedals.map((medal) => ({
      avatar: medal.anchor_info.avatar,
      nick_name: medal.anchor_info.nick_name,
      medal_name: medal.medal.medal_name,
      medal_level: medal.medal.level,
      roomid: medal.room_info.room_id,
      is_lighted: medal.medal.is_lighted === 1,
    }))
    if (uiStore.uiConfig.medalInfoPanelSortMode) {
      const filteredMedals = medals.filter((medal) =>
        config.medalTasks.isWhiteList
          ? config.medalTasks.roomidList.includes(medal.roomid)
          : !config.medalTasks.roomidList.includes(medal.roomid),
      )
      const orderMap = arrayToMap(config.medalTasks.roomidList)
      return filteredMedals.sort((a, b) => orderMap.get(a.roomid)! - orderMap.get(b.roomid)!)
    }
    return medals
  },
  set(newValue: MedalRow[]) {
    config.medalTasks.roomidList = newValue.map((row) => row.roomid)
  },
})

/** 窗口表格数据：点赞模式下展示可点赞的直播间，其余情况展示粉丝勋章名单 */
const medalTableData = computed<MedalRow[]>({
  get() {
    return isLikeMode.value ? likeCandidates.value : medalInfoTableData.value
  },
  set(rows: MedalRow[]) {
    // 点赞模式下的顺序调整没有意义，只有编辑名单时才回写黑白名单
    if (!isLikeMode.value) {
      medalInfoTableData.value = rows
    }
  },
})
/** 是否显示加载中图标 */
const medalInfoLoading = ref<boolean>(false)
/**
 * 编辑名单
 */
const handleEditList = async () => {
  medalInfoPanelMode.value = 'list'
  medalInfoPanelVisible.value = true

  // 等对话框加载好后再对表格进行操作
  await nextTick()
  // 点赞流程会清空表格的选择状态，每次打开都按黑白名单重新勾选
  medalInfoTableRef.value?.clearSelection()

  // 如果没有粉丝勋章信息，先获取
  if (!biliStore.fansMedals) {
    medalInfoLoading.value = true
    // 等待数据被获取到
    watch(
      medalInfoTableData,
      (newData) => {
        nextTick(() => {
          initSelection(newData)
          medalInfoLoading.value = false
        })
      },
      { once: true },
    )
    if (!biliStore.fansMedalsStatus) {
      moduleStore.rerunModule('Default_FansMedals', true)
    }
    return
  }

  initSelection(medalInfoTableData.value)
}
/** 用来管理多选框状态的表格Ref */
const medalInfoTableRef = ref<InstanceType<typeof ElTable>>()

/** 初始化多选框选择状态 */
const initSelection = (rows?: MedalRow[]) => {
  // 排序模式下不初始化多选框选择状态
  if (rows && !uiStore.uiConfig.medalInfoPanelSortMode) {
    config.medalTasks.roomidList.forEach((roomid, index) => {
      const row = rows.find((row) => row.roomid === roomid)
      if (row) {
        medalInfoTableRef.value?.toggleRowSelection(row, true)
      } else {
        // 没有找到直播间号为 roomid 的粉丝勋章，可能是因为该粉丝勋章已被删除或是过滤
        // 从黑白名单中去掉这个 roomid
        config.medalTasks.roomidList.splice(index, 1)
      }
    })
  }
}

function handleSelect(selection: MedalRow[]) {
  // 点赞模式下多选框用来挑选要执行点赞的直播间，不影响黑白名单
  if (isLikeMode.value) {
    likeSelection.value = selection
    return
  }
  config.medalTasks.roomidList = selection.map((row) => row.roomid)
}

function handleRowClick(row: MedalRow) {
  // 排序模式下（仅在编辑名单时有意义）不切换选择状态
  if (!isLikeMode.value && uiStore.uiConfig.medalInfoPanelSortMode) return

  // 切换当前行的选择状态
  medalInfoTableRef.value?.toggleRowSelection(row)
  const selection: MedalRow[] = medalInfoTableRef.value?.getSelectionRows() ?? []
  if (isLikeMode.value) {
    likeSelection.value = selection
  } else {
    config.medalTasks.roomidList = selection.map((row) => row.roomid)
  }
}

/* ---------------- 手动点赞（复用粉丝勋章名单窗口） ---------------- */

/** 拉起手动点赞流程：收集可点赞列表后，把名单窗口切换到点赞模式让用户勾选直播间 */
const manualLikeLoading = ref<boolean>(false)
/** 可点赞的直播间候选（点赞模式下表格的数据源） */
const likeCandidates = ref<MedalRow[]>([])
/** 今日已点赞次数与每日上限，随候选快照一起展示 */
const likeTodayLikes = ref(0)
const likeDailyLimit = ref(0)
const likeSelection = ref<MedalRow[]>([])

/** 取出点赞任务实例 */
function getLightTaskInstance(): LightTask | undefined {
  return moduleStore.moduleInstances['DailyTask_LiveTask_LightTask'] as LightTask | undefined
}

const handleManualLike = async () => {
  const instance = getLightTaskInstance()

  if (!instance) {
    ElMessage.warning('点赞模块尚未加载，请稍后再试')
    return
  }
  if (instance.isManualLikeRunning) {
    ElMessage.warning('点赞任务正在运行中，请等待当前任务结束')
    return
  }
  if (manualLikeLoading.value) return

  manualLikeLoading.value = true
  try {
    // 收集候选会逐个探测直播间、查询点赞进度，耗时与房间数成正比
    const snapshot = await instance.collectLikeCandidates()
    if (!snapshot) return

    if (snapshot.candidates.length === 0) {
      ElMessage.info('没有可以点赞的直播间')
      return
    }

    likeCandidates.value = snapshot.candidates
    likeTodayLikes.value = snapshot.todayLikes
    likeDailyLimit.value = snapshot.dailyLimit
    likeSelection.value = []

    medalInfoPanelMode.value = 'like'
    medalInfoPanelVisible.value = true

    // 等对话框加载好后再对表格进行操作，先清掉上一次的选择再逐行勾选：
    // 表格实例会保留上一次的选择状态，直接 toggleAllSelection 反而会把默认选中的行取消掉。
    // 亲密度储蓄已满的勋章默认不勾选：点赞不再涨亲密度，需要时手动勾上
    await nextTick()
    medalInfoTableRef.value?.clearSelection()
    likeCandidates.value
      .filter((row) => !row.reachFreeIntimacyLimit)
      .forEach((row) => {
        medalInfoTableRef.value?.toggleRowSelection(row, true)
      })
  } catch (error) {
    ElMessage.error(`获取可点赞直播间失败：${(error as Error).message}`)
  } finally {
    // 收集阶段结束、等待用户选择时不再占用按钮的加载状态
    manualLikeLoading.value = false
  }
}

/** 确认点赞：关闭窗口后由模块执行，进度看运行日志 */
const handleConfirmLikeSelection = async () => {
  const instance = getLightTaskInstance()
  if (!instance) {
    medalInfoPanelVisible.value = false
    return
  }

  const roomids = likeSelection.value.map((row) => row.roomid)
  medalInfoPanelVisible.value = false

  try {
    await instance.likeRooms(roomids)
  } catch (error) {
    ElMessage.error(`点赞任务执行出错：${(error as Error).message}`)
  }
}

/** 取消点赞：直接关闭窗口即可，模块侧没有挂起的等待 */
const handleCancelLikeSelection = () => {
  medalInfoPanelVisible.value = false
}

/**
 * 表格选择变化
 *
 * 点赞模式下用它同步勾选结果：默认全选是通过 toggleRowSelection 逐行勾选的，
 * 只会触发 selection-change，不会触发 select / select-all。
 * 名单模式下这里不处理，避免拖拽排序与初始化勾选互相覆盖黑白名单。
 */
const handleSelectionChange = (rows: MedalRow[]) => {
  if (isLikeMode.value) {
    likeSelection.value = rows
  }
}

/** 「点赞30次」任务是否有可展示的进度（未点亮或任务信息缺失时为 false） */
const hasLikeProgress = (row: MedalRow): boolean =>
  typeof row.likeProgress === 'number' && (row.likeProgressTotal ?? 0) > 0

/** 「点赞30次」任务的完成百分比，用于进度条 */
const likePercent = (row: MedalRow): number => {
  const total = row.likeProgressTotal ?? 0
  if (!hasLikeProgress(row) || total <= 0) return 0
  return Math.min(100, Math.round(((row.likeProgress as number) / total) * 100))
}

// 点赞开关即时生效：打开后立即重跑一次该模块，让模块在初始化时把可点赞的
// 直播间查好，之后点【选择直播间点赞】直接展示结果。
// 仅在 false→true 时触发；模块运行中或实例未加载时跳过，避免并发重复运行与异常。
watch(
  () => config.medalTasks.light.likeEnabled,
  (newVal, oldVal) => {
    if (!newVal || oldVal) return
    if (moduleStore.moduleStatus.DailyTasks.LiveTasks.medalTasks.light === 'running') return
    if (!moduleStore.moduleInstances['DailyTask_LiveTask_LightTask']) return
    moduleStore.rerunModule('DailyTask_LiveTask_LightTask')
  },
)

// 弹幕开关即时生效：打开后立即重跑一次该模块，不必等待下一次定时运行（默认次日 00:05）。
// 仅在 false→true 时触发；模块运行中或实例未加载时跳过，避免并发重复运行与异常。
watch(
  () => config.medalTasks.light.danmuEnabled,
  (newVal, oldVal) => {
    if (!newVal || oldVal) return
    if (moduleStore.moduleStatus.DailyTasks.LiveTasks.medalTasks.light === 'running') return
    if (!moduleStore.moduleInstances['DailyTask_LiveTask_LightTask']) return
    moduleStore.rerunModule('DailyTask_LiveTask_LightTask')
  },
)

// 观看直播开关即时生效：打开后立即重跑一次该模块，不必等待下一次定时运行（默认次日 00:05）。
// 仅在 false→true 时触发；模块运行中或实例未加载时跳过，避免并发重复运行与异常。
watch(
  () => config.medalTasks.watch.enabled,
  (newVal, oldVal) => {
    if (!newVal || oldVal) return
    if (moduleStore.moduleStatus.DailyTasks.LiveTasks.medalTasks.watch === 'running') return
    if (!moduleStore.moduleInstances['DailyTask_LiveTask_WatchTask']) return
    moduleStore.rerunModule('DailyTask_LiveTask_WatchTask')
  },
)
</script>

<template>
  <div>
    <!-- 粉丝勋章相关任务 -->
    <el-row>
      <el-space wrap :size="[8, 0]">
        <el-switch v-model="config.medalTasks.light.enabled" active-text="点亮熄灭勋章" />
        <el-switch
          v-model="config.medalTasks.light.likeEnabled"
          active-text="点赞（手动）"
          :disabled="!config.medalTasks.light.enabled"
        />
        <el-button
          type="primary"
          size="small"
          :icon="Check"
          :loading="manualLikeLoading"
          :disabled="!config.medalTasks.light.enabled || !config.medalTasks.light.likeEnabled"
          @click="handleManualLike"
          >选择直播间点赞
        </el-button>
        <el-switch
          v-model="config.medalTasks.light.danmuEnabled"
          active-text="弹幕"
          :disabled="!config.medalTasks.light.enabled"
        />
        <el-button
          type="primary"
          size="small"
          :icon="Edit"
          @click="medalDanmuPanelVisible = !medalDanmuPanelVisible"
          >编辑弹幕
        </el-button>
        <Info :item="helpInfo.DailyTasks.LiveTasks.medalTasks.light" />
        <TaskStatus :status="status.medalTasks.light" @click="reset.medalTasks.light" />
      </el-space>
    </el-row>
    <el-row>
      <el-space wrap :size="[8, 0]">
        <el-switch v-model="config.medalTasks.watch.enabled" active-text="观看直播" />
        <el-select v-model="config.medalTasks.watch.time" placeholder="Select" style="width: 70px">
          <el-option v-for="i in 12" :key="i" :label="i * 5" :value="i * 5" />
        </el-select>
        <el-text>分钟 / 直播间</el-text>
        <Info :item="helpInfo.DailyTasks.LiveTasks.medalTasks.watch" />
        <TaskStatus :status="status.medalTasks.watch" @click="reset.medalTasks.watch" />
      </el-space>
    </el-row>
    <el-row>
      <el-space wrap :size="[8, 0]">
        <el-switch
          v-model="config.medalTasks.isWhiteList"
          active-text="白名单"
          inactive-text="黑名单"
          @change="(val) => !val && (uiStore.uiConfig.medalInfoPanelSortMode = false)"
        />
        <el-button type="primary" size="small" :icon="Edit" @click="handleEditList"
          >编辑名单
        </el-button>
        <Info :item="helpInfo.DailyTasks.LiveTasks.medalTasks.list" />
      </el-space>
    </el-row>
    <el-divider />
    <!-- 说明 -->
    <el-row>
      <el-text>直播任务相关信息可在</el-text>
      <el-link
        rel="noreferrer"
        type="primary"
        href="https://link.bilibili.com/p/help/index#/audience-fans-medal"
        target="_blank"
        >帮助中心
      </el-link>
      <el-text>查看。</el-text>
    </el-row>
    <br />
    <!-- 弹窗 -->
    <el-dialog
      v-model="medalDanmuPanelVisible"
      title="编辑弹幕内容"
      :lock-scroll="false"
      width="40%"
    >
      <el-table :data="danmuTableData" :max-height="danmuTableMaxHeight">
        <el-table-column type="index" width="80" />
        <el-table-column prop="content" label="弹幕内容" />
        <el-table-column label="操作" width="220" align="center">
          <template #default="scope">
            <el-button text :icon="Edit" @click="handleEditDanmu(scope.$index, scope.row)">
              修改
            </el-button>
            <el-button text :icon="Delete" type="danger" @click="handleDeleteDanmu(scope.$index)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button type="primary" @click="handleAddDanmu">新增弹幕</el-button>
      </template>
    </el-dialog>
    <el-dialog
      v-model="medalInfoPanelVisible"
      :title="isLikeMode ? '选择要点赞的直播间' : '编辑粉丝勋章名单'"
      :lock-scroll="false"
      :close-on-click-modal="!isLikeMode"
      :width="isLikeMode ? '85%' : '65%'"
    >
      <el-text v-if="isLikeMode" type="info" class="like-summary">
        共 {{ likeCandidates.length }} 个直播间可以点赞；今日已点亮勋章点赞 {{ likeTodayLikes }} 次（上限
        {{ likeDailyLimit }}，未点亮勋章的点赞不计数、不受限）。亲密度储蓄已满的勋章标记为【已满】并默认不勾选，需要时手动勾上。勾选后点击【开始点赞】，关闭窗口视为取消。
      </el-text>
      <VueDraggable
        v-model="medalTableData"
        target="#draggable-fans-medal-table table tbody"
        :disabled="isLikeMode || !uiStore.uiConfig.medalInfoPanelSortMode"
        :animation="150"
        :scroll-sensitivity="36"
        :scroll-speed="8"
      >
        <el-table
          id="draggable-fans-medal-table"
          ref="medalInfoTableRef"
          v-loading="medalInfoLoading"
          :data="medalTableData"
          :max-height="medalTableMaxHeight"
          empty-text="没有粉丝勋章"
          :row-key="(row: MedalRow) => row.roomid.toString()"
          @select="handleSelect"
          @select-all="handleSelect"
          @selection-change="handleSelectionChange"
          @row-click="handleRowClick"
        >
          <template v-if="isLikeMode || !uiStore.uiConfig.medalInfoPanelSortMode">
            <el-table-column type="selection" align="center" width="60" />
          </template>
          <template v-else>
            <el-table-column type="index" align="center" width="60" />
          </template>

          <el-table-column prop="avatar" label="头像" width="90">
            <template #default="scope">
              <div class="avatar-wrap">
                <el-image
                  :src="scope.row.avatar"
                  loading="lazy"
                  referrerpolicy="origin"
                  class="avatar"
                >
                  <template #error>
                    <el-image
                      src="//i0.hdslb.com/bfs/face/member/noface.jpg"
                      referrerpolicy="origin"
                      class="avatar"
                    />
                  </template>
                </el-image>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="nick_name" label="昵称" min-width="110" />
          <el-table-column prop="medal_name" label="粉丝勋章" min-width="100" />
          <el-table-column prop="medal_level" label="等级" width="70" align="center" />
          <el-table-column label="点亮状态" width="90" align="center">
            <template #default="scope">
              <el-tag :type="scope.row.is_lighted ? 'success' : 'info'" size="small" effect="plain">
                {{ scope.row.is_lighted ? '已点亮' : '未点亮' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="isLikeMode" label="亲密度" width="120" align="center">
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
          <el-table-column v-if="isLikeMode" label="点赞进度" width="150">
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
          <el-table-column prop="roomid" label="房间号" width="120">
            <template #default="scope">
              <el-link
                :href="'https://live.bilibili.com/' + scope.row.roomid + '?visit_id='"
                rel="noreferrer"
                type="primary"
                target="_blank"
                @click.stop
              >
                {{ scope.row.roomid }}
              </el-link>
            </template>
          </el-table-column>
        </el-table>
      </VueDraggable>
      <template #footer>
        <template v-if="isLikeMode">
          <el-button @click="handleCancelLikeSelection()">取消</el-button>
          <el-button
            type="primary"
            :disabled="likeSelection.length === 0"
            @click="handleConfirmLikeSelection"
          >
            开始点赞（{{ likeSelection.length }}）
          </el-button>
        </template>
        <el-switch
          v-else
          v-model="uiStore.uiConfig.medalInfoPanelSortMode"
          :disabled="!config.medalTasks.isWhiteList"
          inactive-text="常规模式"
          active-text="排序模式"
          @change="(val) => !val && nextTick(() => initSelection(medalInfoTableData))"
        />
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.avatar-wrap {
  width: 80px;
  height: 80px;
}

.like-summary {
  display: block;
  margin-bottom: 8px;
  line-height: 1.7;
}

.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}
</style>
