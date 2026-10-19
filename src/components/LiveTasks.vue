<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useModuleStore, useBiliStore, useUIStore } from '@/stores'
import { Edit, Delete } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox, ElTable } from 'element-plus'
import helpInfo from '@/library/help-info'
import { VueDraggable } from 'vue-draggable-plus'
import { arrayToMap } from '@/library/utils'

interface MedalInfoRow {
  avatar: string
  nick_name: string
  medal_name: string
  medal_level: number
  roomid: number
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

const reserveLikePanelVisible = ref<boolean>(false)
const reserveLikeTableData = computed(() =>
  config.medalTasks.light.reserveLikeRoomids.map((roomid) => {
    const medal = biliStore.filteredFansMedals.find((m) => m.room_info.room_id === roomid)
    return {
      roomid,
      nick_name: medal ? medal.anchor_info.nick_name : '不在粉丝勋章列表中',
    }
  }),
)

const handleDeleteReserveLike = (index: number) => {
  config.medalTasks.light.reserveLikeRoomids.splice(index, 1)
}

const handleAddReserveLike = () => {
  ElMessageBox.prompt('请输入要预留点赞的直播间号', '新增预留直播间', {
    confirmButtonText: '确认',
    cancelButtonText: '取消',
    inputPattern: /^\d+$/,
    inputErrorMessage: '直播间号应为数字',
    lockScroll: false,
  })
    .then(({ value }) => {
      const roomid = Number(value)
      if (config.medalTasks.light.reserveLikeRoomids.includes(roomid)) {
        ElMessage.warning({
          message: '该直播间已在预留列表中',
          appendTo: '.el-dialog',
        })
        return
      }
      config.medalTasks.light.reserveLikeRoomids.push(roomid)
    })
    .catch(() => {})
}

const medalInfoPanelVisible = ref<boolean>(false)
const medalInfoTableData = computed({
  get() {
    const medals = biliStore.filteredFansMedals.map((medal) => ({
      avatar: medal.anchor_info.avatar,
      nick_name: medal.anchor_info.nick_name,
      medal_name: medal.medal.medal_name,
      medal_level: medal.medal.level,
      roomid: medal.room_info.room_id,
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
  set(newValue: MedalInfoRow[]) {
    config.medalTasks.roomidList = newValue.map((row) => row.roomid)
  },
})
/** 是否显示加载中图标 */
const medalInfoLoading = ref<boolean>(false)
/** 是否是第一次点击编辑名单按钮 */
let firstClickEditList = true
/**
 * 编辑名单
 */
const handleEditList = async () => {
  medalInfoPanelVisible.value = true

  if (firstClickEditList) {
    // 第一次点击编辑名单按钮时需要初始化多选框状态
    firstClickEditList = false
    // 等对话框加载好后再对表格进行操作
    await nextTick()
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
    } else {
      initSelection(medalInfoTableData.value)
    }
  }
}
/** 用来管理多选框状态的表格Ref */
const medalInfoTableRef = ref<InstanceType<typeof ElTable>>()

/** 初始化多选框选择状态 */
const initSelection = (rows?: MedalInfoRow[]) => {
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

function handleSelect(selection: MedalInfoRow[]) {
  config.medalTasks.roomidList = selection.map((row) => row.roomid)
}

function handleRowClick(row: MedalInfoRow) {
  // 排序模式下不切换选择状态
  if (!uiStore.uiConfig.medalInfoPanelSortMode) {
    // 切换当前行的选择状态
    medalInfoTableRef.value?.toggleRowSelection(row)
    // 更新黑白名单
    const selection: MedalInfoRow[] = medalInfoTableRef.value?.getSelectionRows() ?? []
    config.medalTasks.roomidList = selection.map((row) => row.roomid)
  }
}

// 开关即时生效：打开「点赞/弹幕」开关后立即重跑一次该模块，
// 不必等待下一次定时运行（默认次日 00:05），也无需手动点击状态徽标。
// 为避免与正在运行的实例并发，仅在模块当前未运行时触发；
// 运行中变更开关则顺延至下一次运行生效。自动关闭（true→false）不触发。
watch(
  () => [config.medalTasks.light.likeEnabled, config.medalTasks.light.danmuEnabled],
  ([likeNew, danmuNew], [likeOld, danmuOld]) => {
    const turnedOn = (likeNew && !likeOld) || (danmuNew && !danmuOld)
    if (!turnedOn) return
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
          active-text="点赞"
          :disabled="!config.medalTasks.light.enabled"
        />
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
        <el-button
          type="primary"
          size="small"
          :icon="Edit"
          :disabled="!config.medalTasks.light.enabled"
          @click="reserveLikePanelVisible = !reserveLikePanelVisible"
          >预留点赞直播间
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
      v-model="reserveLikePanelVisible"
      title="编辑预留点赞直播间"
      :lock-scroll="false"
      width="40%"
    >
      <el-text type="info">每个预留直播间每天固定点赞 360 次，优先于点其他直播间执行。</el-text>
      <el-table :data="reserveLikeTableData" :max-height="danmuTableMaxHeight">
        <el-table-column type="index" width="80" />
        <el-table-column prop="nick_name" label="昵称" />
        <el-table-column prop="roomid" label="房间号">
          <template #default="scope">
            <el-link
              :href="'https://live.bilibili.com/' + scope.row.roomid + '?visit_id='"
              rel="noreferrer"
              type="primary"
              target="_blank"
            >
              {{ scope.row.roomid }}
            </el-link>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" align="center">
          <template #default="scope">
            <el-button text :icon="Delete" type="danger" @click="handleDeleteReserveLike(scope.$index)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button type="primary" @click="handleAddReserveLike">新增直播间</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="medalInfoPanelVisible" title="编辑粉丝勋章名单" :lock-scroll="false">
      <VueDraggable
        v-model="medalInfoTableData"
        target="#draggable-fans-medal-table table tbody"
        :disabled="!uiStore.uiConfig.medalInfoPanelSortMode"
        :animation="150"
        :scroll-sensitivity="36"
        :scroll-speed="8"
      >
        <el-table
          id="draggable-fans-medal-table"
          ref="medalInfoTableRef"
          v-loading="medalInfoLoading"
          :data="medalInfoTableData"
          :max-height="medalTableMaxHeight"
          empty-text="没有粉丝勋章"
          :row-key="(row: MedalInfoRow) => row.roomid.toString()"
          @select="handleSelect"
          @select-all="handleSelect"
          @row-click="handleRowClick"
        >
          <template v-if="!uiStore.uiConfig.medalInfoPanelSortMode">
            <el-table-column type="selection" align="center" width="80" />
          </template>
          <template v-else>
            <el-table-column type="index" align="center" width="80" />
          </template>

          <el-table-column prop="avatar" label="头像" width="100">
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
          <el-table-column prop="nick_name" label="昵称" />
          <el-table-column prop="medal_name" label="粉丝勋章" />
          <el-table-column prop="medal_level" label="等级" width="80" />
          <el-table-column prop="roomid" label="房间号">
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
        <el-switch
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

.avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}
</style>
