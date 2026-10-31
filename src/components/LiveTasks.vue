<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useModuleStore, useBiliStore, useUIStore } from '@/stores'
import { Check, Edit, Delete, Rank, Search, Star } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox, ElTable } from 'element-plus'
import helpInfo from '@/library/help-info'
import { VueDraggable } from 'vue-draggable-plus'
import { arrayToMap, CANCELLED_NICK_NAME } from '@/library/utils'
import type LightTask from '@/modules/dailyTasks/liveTasks/medalTasks/lightTask'

interface MedalRow {
  avatar: string
  /** 昵称；账号已注销的显示保留的原名，原名为空则显示「账号已注销」 */
  nick_name: string
  medal_name: string
  medal_level: number
  roomid: number
  /** 主播 UID */
  uid: number
  /** 粉丝勋章是否已点亮 */
  is_lighted: boolean
  /** 账号是否已注销 */
  is_canceled: boolean
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
/** 名单窗口的用途：编辑黑白名单 / 选择要执行点赞的直播间 / 编辑优先名单（点赞与优先名单复用同一个窗口） */
const medalInfoPanelMode = ref<'list' | 'like' | 'priority'>('list')
const isLikeMode = computed(() => medalInfoPanelMode.value === 'like')
const isPriorityMode = computed(() => medalInfoPanelMode.value === 'priority')

/** 名单里已保存的用户名（key：直播间号），账号已注销时用它显示原名 */
const storedNameByRoomid = computed<Map<number, string>>(() => {
  const map = new Map<number, string>()
  for (const entry of [...config.medalTasks.roomidList, ...config.medalTasks.roomidList2]) {
    if (entry.name && !map.has(entry.roomid)) {
      map.set(entry.roomid, entry.name)
    }
  }
  return map
})

/** 粉丝勋章名单的完整数据（不受排序模式影响），优先名单窗口直接用这一份；含账号已注销 */
const allMedalRows = computed<MedalRow[]>(() =>
  biliStore.filteredFansMedals.map((medal) => {
    const is_canceled = medal.anchor_info.nick_name === CANCELLED_NICK_NAME
    return {
      avatar: medal.anchor_info.avatar,
      nick_name: is_canceled
        ? storedNameByRoomid.value.get(medal.room_info.room_id) || CANCELLED_NICK_NAME
        : medal.anchor_info.nick_name,
      medal_name: medal.medal.medal_name,
      medal_level: medal.medal.level,
      roomid: medal.room_info.room_id,
      uid: medal.medal.target_id,
      is_lighted: medal.medal.is_lighted === 1,
      is_canceled,
    }
  }),
)

const medalInfoTableData = computed({
  get() {
    const medals = allMedalRows.value
    if (uiStore.uiConfig.medalInfoPanelSortMode) {
      const listRoomids = new Set(config.medalTasks.roomidList.map((entry) => entry.roomid))
      const filteredMedals = medals.filter((medal) =>
        config.medalTasks.isWhiteList
          ? listRoomids.has(medal.roomid)
          : !listRoomids.has(medal.roomid),
      )
      const orderMap = arrayToMap(config.medalTasks.roomidList.map((entry) => entry.roomid))
      return filteredMedals.sort((a, b) => orderMap.get(a.roomid)! - orderMap.get(b.roomid)!)
    }
    return medals
  },
  set(newValue: MedalRow[]) {
    config.medalTasks.roomidList = newValue.map((row) => ({
      roomid: row.roomid,
      name: row.nick_name,
    }))
  },
})

/** 窗口表格数据：点赞模式下展示可点赞的直播间，优先名单模式下展示全部粉丝勋章，其余情况展示黑白名单 */
const medalTableData = computed<MedalRow[]>({
  get() {
    if (isLikeMode.value) return likeCandidates.value
    if (isPriorityMode.value) return allMedalRows.value
    return medalInfoTableData.value
  },
  set(rows: MedalRow[]) {
    // 点赞模式下的顺序调整没有意义，优先名单不通过拖拽编辑，只有编辑名单时才回写黑白名单
    if (!isLikeMode.value && !isPriorityMode.value) {
      medalInfoTableData.value = rows
    }
  },
})
/** 窗口内搜索关键字（昵称 / 粉丝勋章 / 房间号 / UID），只影响显示 */
const medalSearchText = ref<string>('')
/** 窗口内筛选条件，只影响显示 */
const medalFilter = ref<'all' | 'lighted' | 'unlighted' | 'checked' | 'unchecked'>('all')
/** 搜索/筛选是否生效 */
const medalFilterActive = computed(
  () => medalSearchText.value.trim() !== '' || medalFilter.value !== 'all',
)
/** 搜索/筛选后的显示行 */
const filteredMedalRows = computed<MedalRow[]>(() => {
  // 复制一份，避免表格内置排序改动数据源，进而影响名单回写顺序
  let rows = [...medalTableData.value]
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
  if (medalFilter.value === 'lighted' || medalFilter.value === 'unlighted') {
    rows = rows.filter((row) => row.is_lighted === (medalFilter.value === 'lighted'))
  } else if (medalFilter.value === 'checked' || medalFilter.value === 'unchecked') {
    // 勾选状态随编辑实时变化：在「仅已勾选」下取消勾选后该行会立即移出显示
    const checked = new Set(getCheckedRoomids())
    rows = rows.filter((row) => checked.has(row.roomid) === (medalFilter.value === 'checked'))
  }
  return rows
})
/** 表格是否提供多选框（排序模式下编辑名单时用拖拽排序，不提供多选框） */
const medalTableHasSelection = computed(
  () => isLikeMode.value || isPriorityMode.value || !uiStore.uiConfig.medalInfoPanelSortMode,
)
/** 表头是否可点击排序；排序模式下拖拽顺序才是执行顺序，此时不提供表头排序 */
const medalTableSortable = computed(
  () => medalInfoPanelMode.value !== 'list' || !uiStore.uiConfig.medalInfoPanelSortMode,
)

/** 是否显示加载中图标 */
const medalInfoLoading = ref<boolean>(false)
/** 用来管理多选框状态的表格Ref */
const medalInfoTableRef = ref<InstanceType<typeof ElTable>>()

/** 当前窗口已勾选的直播间号，数组顺序即最终写入顺序：点赞模式是待点赞的房间，其余是对应名单 */
const getCheckedRoomids = (): number[] =>
  isLikeMode.value
    ? likeSelection.value.map((row) => row.roomid)
    : isPriorityMode.value
      ? config.medalTasks.roomidList2.map((entry) => entry.roomid)
      : config.medalTasks.roomidList.map((entry) => entry.roomid)

/** 窗口中可勾选的行：点赞模式是候选直播间，其余是全部粉丝勋章 */
const sourceRows = computed<MedalRow[]>(() =>
  isLikeMode.value ? likeCandidates.value : allMedalRows.value,
)

/** 把最终顺序回写到对应名单；用户名取自当前行（留空则为空字符串） */
const writeCheckedRoomids = (roomids: number[]) => {
  if (isLikeMode.value) {
    const rowByRoomid = new Map(sourceRows.value.map((row) => [row.roomid, row]))
    likeSelection.value = roomids
      .map((roomid) => rowByRoomid.get(roomid))
      .filter((row): row is MedalRow => Boolean(row))
    return
  }
  const nameByRoomid = new Map(sourceRows.value.map((row) => [row.roomid, row.nick_name]))
  const entries = roomids.map((roomid) => ({ roomid, name: nameByRoomid.get(roomid) ?? '' }))
  if (isPriorityMode.value) {
    config.medalTasks.roomidList2 = entries
  } else {
    config.medalTasks.roomidList = entries
  }
}

/** 把勾选结果同步到表格，只处理当前显示的行 */
const syncSelection = () => {
  if (!medalTableHasSelection.value) return
  const checked = new Set(getCheckedRoomids())
  filteredMedalRows.value.forEach((row) => {
    medalInfoTableRef.value?.toggleRowSelection(row, checked.has(row.roomid))
  })
}

/**
 * 打开窗口时按名单初始化勾选
 *
 * 名单里可能残留已被删除或没有真实直播间的粉丝勋章，勾选前先把没有对应行的直播间号剔除。
 */
const initSelection = () => {
  const available = new Set(allMedalRows.value.map((row) => row.roomid))
  if (isPriorityMode.value) {
    config.medalTasks.roomidList2 = config.medalTasks.roomidList2.filter((entry) =>
      available.has(entry.roomid),
    )
  } else if (!isLikeMode.value) {
    config.medalTasks.roomidList = config.medalTasks.roomidList.filter((entry) =>
      available.has(entry.roomid),
    )
  }
  syncSelection()
}

/** 打开窗口时清空搜索与筛选 */
const resetMedalFilters = () => {
  medalSearchText.value = ''
  medalFilter.value = 'all'
}

// 搜索/筛选后表格行会被替换，重新按名单勾选，避免勾选状态丢失
watch(filteredMedalRows, () => nextTick(syncSelection))

/** 调整写入顺序窗口是否可见 */
const orderPanelVisible = ref<boolean>(false)
// 名单窗口关闭时一并关闭顺序窗口，避免下次打开时残留
watch(medalInfoPanelVisible, (visible) => {
  if (!visible) orderPanelVisible.value = false
})

/** 已勾选的行，按最终写入顺序排列 */
const orderedCheckedRows = computed<MedalRow[]>({
  get() {
    const rowByRoomid = new Map(sourceRows.value.map((row) => [row.roomid, row]))
    return getCheckedRoomids()
      .map((roomid) => rowByRoomid.get(roomid))
      .filter((row): row is MedalRow => Boolean(row))
  },
  set(rows: MedalRow[]) {
    writeCheckedRoomids(rows.map((row) => row.roomid))
  },
})

/** 恢复默认顺序：按表格顺序排列 */
const resetOrder = () => {
  const checked = new Set(getCheckedRoomids())
  writeCheckedRoomids(
    sourceRows.value.filter((row) => checked.has(row.roomid)).map((row) => row.roomid),
  )
}

/** 名单窗口宽度：未拖拽过时是模式默认值（%），拖拽后固定为像素宽 */
const medalInfoPanelWidth = ref<string>('65%')
/** 用户是否已拖拽过窗口宽度（拖过后打开窗口不再恢复模式默认宽度） */
const medalPanelWidthCustomized = ref(false)

/** 打开窗口时给默认宽度（用户拖拽过则保持不动） */
const applyDefaultPanelWidth = () => {
  if (medalPanelWidthCustomized.value) return
  medalInfoPanelWidth.value = isLikeMode.value ? '85%' : '65%'
}

/** 是否正在拖拽窗口宽度（防止 pointerdown 与 mousedown 重复进入） */
let panelResizing = false

/**
 * 按住窗口右侧拖拽条左右拖动调整窗口宽度
 *
 * 拖拽条挂在窗口边框上（内外各占一半），常态可见，方便直接抓住窗口边缘拖动。
 *
 * 实现上刻意不依赖组件的事件绑定与冒泡：
 * - 拖拽入口在 document 的**捕获阶段**监听，pointerdown / mousedown 任意一个先到就开拖，
 *   页面里其他代码 stopPropagation 也拦不住；
 * - 移动和松开同样监听 pointermove/mousemove、pointerup/mouseup 两套事件，
 *   两套都到达时按同一公式计算，结果一致，不会互相干扰；
 * - 宽度同时写内联 CSS 变量 `--el-dialog-width` 与内联 `width`，不依赖 element-plus 版本细节。
 */
const startPanelResize = (e: MouseEvent | PointerEvent, handleEl: HTMLElement) => {
  if (panelResizing) return
  const dialogEl = handleEl.closest('.el-dialog') as HTMLElement | null
  if (!dialogEl) return

  // 不在 pointerdown 上 preventDefault：那会让浏览器抑制随后的 mousedown/mousemove，
  // 万一某个环境下指针事件不正常，鼠标事件这条后路也就废了。
  // 拖拽期间靠 user-select: none 阻止选中即可。
  panelResizing = true

  const startX = e.clientX
  const startWidth = dialogEl.getBoundingClientRect().width
  const minWidth = 480
  const maxWidth = Math.max(minWidth, window.innerWidth - 40)

  const onMove = (ev: MouseEvent | PointerEvent) => {
    const clamped = Math.min(Math.max(startWidth + ev.clientX - startX, minWidth), maxWidth)
    const px = `${Math.round(clamped)}px`
    // 直接写样式，拖动过程立即生效
    dialogEl.style.setProperty('--el-dialog-width', px)
    dialogEl.style.width = px
    // 同步到状态，下次打开窗口时沿用
    medalInfoPanelWidth.value = px
    medalPanelWidthCustomized.value = true
  }

  const onUp = () => {
    panelResizing = false
    document.removeEventListener('pointermove', onMove, true)
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('pointerup', onUp, true)
    document.removeEventListener('mouseup', onUp, true)
    document.removeEventListener('pointercancel', onUp, true)
    document.body.style.removeProperty('user-select')
    document.body.style.removeProperty('cursor')
  }

  document.addEventListener('pointermove', onMove, true)
  document.addEventListener('mousemove', onMove, true)
  document.addEventListener('pointerup', onUp, true)
  document.addEventListener('mouseup', onUp, true)
  document.addEventListener('pointercancel', onUp, true)
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'ew-resize'
}

/** 捕获阶段识别「按在拖拽条上」，开拖 */
const handlePanelResizePointerDown = (e: MouseEvent | PointerEvent) => {
  const target = e.target as HTMLElement | null
  const handleEl = target?.closest?.('.panel-resize-handle') as HTMLElement | null
  if (handleEl) startPanelResize(e, handleEl)
}

onMounted(() => {
  // 捕获阶段监听，先于页面上任何冒泡处理，且不依赖模板上的事件绑定
  document.addEventListener('pointerdown', handlePanelResizePointerDown, true)
  document.addEventListener('mousedown', handlePanelResizePointerDown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handlePanelResizePointerDown, true)
  document.removeEventListener('mousedown', handlePanelResizePointerDown, true)
})

/**
 * 打开名单窗口
 * @param mode 窗口用途：编辑黑白名单 / 编辑优先名单
 */
const openMedalPanel = async (mode: 'list' | 'priority') => {
  medalInfoPanelMode.value = mode
  applyDefaultPanelWidth()
  resetMedalFilters()
  medalInfoPanelVisible.value = true

  // 等对话框加载好后再对表格进行操作
  await nextTick()
  // 点赞流程会清空表格的选择状态，每次打开都按对应名单重新勾选
  medalInfoTableRef.value?.clearSelection()

  // 如果没有粉丝勋章信息，先获取
  if (!biliStore.fansMedals) {
    medalInfoLoading.value = true
    // 等待数据被获取到
    watch(
      allMedalRows,
      () => {
        nextTick(() => {
          initSelection()
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

  initSelection()
}
/** 编辑名单 */
const handleEditList = () => openMedalPanel('list')
/** 编辑优先名单 */
const handleEditPriorityList = () => openMedalPanel('priority')

function handleSelect(selection: MedalRow[]) {
  const visibleIds = new Set(filteredMedalRows.value.map((row) => row.roomid))
  const selectedIds = new Set(selection.map((row) => row.roomid))
  // 搜索/筛选隐藏的行保持原勾选状态，显示的行以本次选择为准；
  // 已勾选的保持原有写入顺序，新勾选的排在末尾
  const roomids = getCheckedRoomids().filter(
    (roomid) => !visibleIds.has(roomid) || selectedIds.has(roomid),
  )
  const known = new Set(roomids)
  sourceRows.value.forEach((row) => {
    if (selectedIds.has(row.roomid) && !known.has(row.roomid)) {
      roomids.push(row.roomid)
      known.add(row.roomid)
    }
  })
  writeCheckedRoomids(roomids)
}

function handleRowClick(row: MedalRow) {
  // 排序模式下（仅在编辑名单时有意义）不切换选择状态
  if (!medalTableHasSelection.value) return

  const roomids = getCheckedRoomids()
  const index = roomids.indexOf(row.roomid)
  if (index >= 0) {
    roomids.splice(index, 1)
    writeCheckedRoomids(roomids)
    medalInfoTableRef.value?.toggleRowSelection(row, false)
  } else {
    // 新勾选的排在末尾，具体位置在【调整顺序】窗口里改
    writeCheckedRoomids([...roomids, row.roomid])
    medalInfoTableRef.value?.toggleRowSelection(row, true)
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

    // LikeRoomCandidate 补齐 MedalRow 的 is_canceled，昵称按名单窗口的规则显示
    likeCandidates.value = snapshot.candidates.map((row) => {
      const is_canceled = row.nick_name === CANCELLED_NICK_NAME
      return {
        ...row,
        nick_name: is_canceled
          ? storedNameByRoomid.value.get(row.roomid) || CANCELLED_NICK_NAME
          : row.nick_name,
        is_canceled,
      }
    })
    likeTodayLikes.value = snapshot.todayLikes
    likeDailyLimit.value = snapshot.dailyLimit
    // 亲密度储蓄已满的勋章默认不勾选：点赞不再涨亲密度，需要时手动勾上
    likeSelection.value = likeCandidates.value.filter((row) => !row.reachFreeIntimacyLimit)

    medalInfoPanelMode.value = 'like'
    applyDefaultPanelWidth()
    resetMedalFilters()
    medalInfoPanelVisible.value = true

    // 等对话框加载好后再把勾选状态同步到表格
    await nextTick()
    medalInfoTableRef.value?.clearSelection()
    syncSelection()
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
        <el-button type="primary" size="small" :icon="Star" @click="handleEditPriorityList"
          >优先名单
        </el-button>
        <Info :item="helpInfo.DailyTasks.LiveTasks.medalTasks.priority" />
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
      :title="
        isLikeMode ? '选择要点赞的直播间' : isPriorityMode ? '编辑优先名单' : '编辑粉丝勋章名单'
      "
      :lock-scroll="false"
      :close-on-click-modal="!isLikeMode"
      :width="medalInfoPanelWidth"
    >
      <!-- 右缘拖拽条：按住左右拖动调整窗口宽度（拖拽入口在 document 捕获阶段统一监听） -->
      <div class="panel-resize-handle" title="拖拽调整窗口宽度"></div>
      <el-text v-if="isLikeMode" type="info" class="panel-summary">
        共 {{ likeCandidates.length }} 个直播间可以点赞；今日已点亮勋章点赞 {{ likeTodayLikes }} 次（上限
        {{ likeDailyLimit }}，未点亮勋章的点赞不计数、不受限）。亲密度储蓄已满的勋章标记为【已满】并默认不勾选，需要时手动勾上。勾选后点击【开始点赞】，关闭窗口视为取消。
      </el-text>
      <el-text v-if="isPriorityMode" type="info" class="panel-summary">
        roomidList2
      </el-text>
      <el-row class="filter-bar" :gutter="8">
        <el-col :span="11">
          <el-input
            v-model="medalSearchText"
            placeholder="搜索昵称 / 粉丝勋章 / 房间号 / UID"
            clearable
            :prefix-icon="Search"
          />
        </el-col>
        <el-col :span="7">
          <el-select v-model="medalFilter" style="width: 100%">
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
        </el-col>
        <el-col :span="6">
          <el-button :icon="Rank" style="width: 100%" @click="orderPanelVisible = true"
            >调整顺序
          </el-button>
        </el-col>
      </el-row>
      <VueDraggable
        v-model="medalTableData"
        target="#draggable-fans-medal-table table tbody"
        :disabled="
          isLikeMode || isPriorityMode || medalFilterActive || !uiStore.uiConfig.medalInfoPanelSortMode
        "
        :animation="150"
        :scroll-sensitivity="36"
        :scroll-speed="8"
      >
        <el-table
          id="draggable-fans-medal-table"
          ref="medalInfoTableRef"
          v-loading="medalInfoLoading"
          :data="filteredMedalRows"
          :max-height="medalTableMaxHeight"
          :empty-text="medalFilterActive ? '没有匹配的粉丝勋章' : '没有粉丝勋章'"
          :row-key="(row: MedalRow) => row.roomid.toString()"
          @select="handleSelect"
          @select-all="handleSelect"
          @row-click="handleRowClick"
        >
          <template v-if="medalTableHasSelection">
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
          <el-table-column
            prop="nick_name"
            label="昵称"
            min-width="110"
            :sortable="medalTableSortable"
          >
            <template #default="scope">
              <span>{{ scope.row.nick_name }}</span>
              <el-tag
                v-if="scope.row.is_canceled"
                type="info"
                size="small"
                effect="plain"
                class="cancelled-tag"
              >
                已注销
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            prop="medal_name"
            label="粉丝勋章"
            min-width="100"
            :sortable="medalTableSortable"
          />
          <el-table-column
            prop="medal_level"
            label="等级"
            width="70"
            align="center"
            :sortable="medalTableSortable"
          />
          <el-table-column label="点亮状态" width="90" align="center">
            <template #default="scope">
              <el-tag :type="scope.row.is_lighted ? 'success' : 'info'" size="small" effect="plain">
                {{ scope.row.is_lighted ? '已点亮' : '未点亮' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="isLikeMode" label="亲密度储蓄" width="120" align="center">
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
          <el-table-column
            prop="roomid"
            label="房间号"
            width="120"
            :sortable="medalTableSortable"
          >
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
          <el-table-column prop="uid" label="UID" width="120" :sortable="medalTableSortable">
            <template #default="scope">
              <el-link
                :href="'https://space.bilibili.com/' + scope.row.uid"
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
        <el-text v-else-if="isPriorityMode" type="info">
          已选 {{ config.medalTasks.roomidList2.length }} 个直播间
        </el-text>
        <template v-else>
          <el-text
            v-if="medalFilterActive && uiStore.uiConfig.medalInfoPanelSortMode"
            type="info"
            class="filter-hint"
          >
            搜索/筛选生效时无法拖拽排序
          </el-text>
          <el-switch
            v-model="uiStore.uiConfig.medalInfoPanelSortMode"
            :disabled="!config.medalTasks.isWhiteList"
            inactive-text="常规模式"
            active-text="排序模式"
            @change="(val) => !val && nextTick(() => initSelection())"
          />
        </template>
      </template>
      <el-dialog v-model="orderPanelVisible" title="调整写入顺序" :lock-scroll="false" width="40%">
        <el-text type="info" class="panel-summary">
          拖拽调整名单的写入顺序，顺序决定任务执行的先后；新勾选的直播间会排在末尾。
        </el-text>
        <el-empty
          v-if="orderedCheckedRows.length === 0"
          description="还没有勾选任何直播间"
          :image-size="60"
        />
        <VueDraggable v-else v-model="orderedCheckedRows" class="order-list" :animation="150">
          <div v-for="(row, index) in orderedCheckedRows" :key="row.roomid" class="order-item">
            <el-icon class="order-handle"><Rank /></el-icon>
            <el-text>{{ index + 1 }}. {{ row.nick_name }}（{{ row.roomid }}）</el-text>
          </div>
        </VueDraggable>
        <template #footer>
          <el-button @click="resetOrder">恢复默认顺序</el-button>
          <el-button type="primary" @click="orderPanelVisible = false">完成</el-button>
        </template>
      </el-dialog>
    </el-dialog>
  </div>
</template>

<style scoped>
.avatar-wrap {
  width: 80px;
  height: 80px;
}

.panel-summary {
  display: block;
  margin-bottom: 8px;
  line-height: 1.7;
}

.filter-bar {
  margin-bottom: 8px;
}

/* 窗口内搜索提示文字用小字号，输入内容字号不变 */
.filter-bar :deep(.el-input__inner::placeholder) {
  font-size: 12px;
}

.filter-hint {
  margin-right: 8px;
}

/* 窗口右缘拖拽条：贴在窗口边框上（内外各占一半），常态可见便于直接抓住窗口边缘拖动 */
.panel-resize-handle {
  position: absolute;
  top: 0;
  /* 跨在窗口边框上：负偏移让一半露在边框外 */
  right: -6px;
  bottom: 0;
  z-index: 3;
  width: 12px;
  cursor: ew-resize;
  background: var(--el-color-primary-light-7);
  border-right: 2px solid var(--el-color-primary-light-5);
  border-radius: 0 4px 4px 0;
  transition: background-color 0.15s;
}

.panel-resize-handle:hover {
  background: var(--el-color-primary-light-3);
  border-right-color: var(--el-color-primary);
}

.cancelled-tag {
  margin-left: 4px;
}

.order-list {
  max-height: 40vh;
  padding: 2px;
  overflow: auto;
}

.order-item {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  margin-bottom: 6px;
  cursor: grab;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
}

.order-handle {
  color: var(--el-text-color-secondary);
  cursor: grab;
}

.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}
</style>
