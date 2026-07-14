import BaseModule from '@/modules/BaseModule'
import { storeToRefs } from 'pinia'
import { useBiliStore, useModuleStore } from '@/stores'
import { watch } from 'vue'
import type { PublicMedalFilters, LiveStatusSnapshot, RequestQueueKey } from './types'
import { arrayToMap, sleep } from '@/library/utils'
import type { LiveData } from '@/library/bili-api/data'
import BAPI from '@/library/bili-api'
import { tsm } from '@/library/luxon'
import _ from 'lodash'

class MedalModule extends BaseModule {
  /** 单房间探测时相邻请求间的随机延迟 */
  private static get ROOM_STATUS_PROBE_DYNAMIC_DELAY() {
    return _.random(600, 800)
  }
  /** 任务信息请求队列中相邻请求间的随机延迟 */
  private static get TASK_INFO_REQUEST_DYNAMIC_DELAY() {
    return _.random(300, 500)
  }
  /** 串行执行请求的限流队列 */
  private static readonly requestQueues: Record<RequestQueueKey, Promise<void>> = {
    taskInfo: Promise.resolve(),
    roomStatus: Promise.resolve(),
  }
  /** 直播状态快照在多久内视为新鲜、可直接复用（毫秒） */
  private static readonly LIVE_STATUS_SNAPSHOT_FRESHNESS_THRESHOLD = 60_000
  /** 直播状态快照（key：直播间号） */
  private static readonly liveStatusSnapshots = new Map<number, LiveStatusSnapshot>()

  medalTasksConfig = useModuleStore().moduleConfig.DailyTasks.LiveTasks.medalTasks

  protected PUBLIC_MEDAL_FILTERS: PublicMedalFilters = {
    // 包含在白名单中或不包含在黑名单中返回true，否则返回false
    whiteBlackList: (m) =>
      this.medalTasksConfig.isWhiteList
        ? this.medalTasksConfig.roomidList.includes(m.room_info.room_id)
        : !this.medalTasksConfig.roomidList.includes(m.room_info.room_id),
    // 等级小于120返回true，否则返回false
    levelLt120: (medal) => medal.medal.level < 120,
  }

  protected sortMedals(medals: LiveData.FansMedalPanel.List[]): LiveData.FansMedalPanel.List[] {
    const orderMap = arrayToMap(this.medalTasksConfig.roomidList)
    return medals.sort(
      (a, b) => orderMap.get(a.room_info.room_id)! - orderMap.get(b.room_info.room_id)!,
    )
  }

  /**
   * 等待粉丝勋章数据获取完毕
   *
   * @returns 是否获取成功
   */
  protected waitForFansMedals(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const { fansMedalsStatus } = storeToRefs(useBiliStore())
      if (fansMedalsStatus.value === 'loaded') {
        resolve(true)
      } else {
        const unwatch = watch(fansMedalsStatus, (newValue) => {
          if (newValue === 'loaded') {
            unwatch()
            resolve(true)
          } else if (newValue === 'error') {
            unwatch()
            resolve(false)
          }
        })
      }
    })
  }

  sort_live_medals = (a: LiveData.FansMedalPanel.List, b: LiveData.FansMedalPanel.List) => {
    const roomid2 = this.medalTasksConfig.roomidList2
    if (roomid2.includes(a.room_info.room_id) && roomid2.includes(b.room_info.room_id))
      return roomid2.indexOf(a.room_info.room_id) - roomid2.indexOf(b.room_info.room_id);
    else if (roomid2.includes(a.room_info.room_id))
      return -1;
    else if (roomid2.includes(b.room_info.room_id))
      return 1;
    if (a.medal.level === b.medal.level)
      return b.medal.intimacy - a.medal.intimacy;
    return b.medal.level - a.medal.level;
  };

  /**
   * 通过获取指定页的粉丝勋章，探测目标直播间的直播状态
   */
  private async fetchMedalPageForLiveStatus(
    page: number,
    roomid: number,
  ): Promise<{ status: number | null; canTryNextPage: boolean }> {
    try {
      const response = await BAPI.live.fansMedalPanel(page)
      console.log(`BAPI.live.fansMedalPanel(${page}) response`, response)
      let status = null

      if (response.code === 0) {
        const medals = [...response.data.special_list, ...response.data.list]
        const observedAt = tsm()

        for (const medal of medals) {
          const medalRoomid = medal.room_info.room_id
          const medalLiveStatus = medal.room_info.living_status

          MedalModule.liveStatusSnapshots.set(medalRoomid, {
            liveStatus: medalLiveStatus,
            observedAt,
          })

          if (medalRoomid === roomid) {
            status = medalLiveStatus
          }
        }

        const currentPage = response.data.page_info.current_page
        const totalPage = response.data.page_info.total_page
        const hasUnlightedMedal = medals.some((m) => !m.medal.is_lighted)

        return {
          status,
          canTryNextPage: currentPage < totalPage && !hasUnlightedMedal,
        }
      }
      console.warn(`BAPI.live.fansMedalPanel(${page}) 失败`, response.message)
    } catch (error) {
      console.warn(`BAPI.live.fansMedalPanel(${page}) 出错`, error)
    }
    return { status: null, canTryNextPage: false }
  }

  /**
   * 直播间直播状态获取函数列表（获取失败时返回null）
   */
  private readonly ROOM_LIVE_STATUS_FETCHERS: Array<(roomid: number) => Promise<number | null>> = [
    async (roomid) => {
      // 计算 roomid 对应的粉丝勋章在第几页
      const roomids = useBiliStore().filteredFansMedals
      let index = -1
      for (const r of roomids) {
        index++
        if (r.room_info.room_id === roomid) {
          break
        }
      }

      // 获取粉丝勋章 API 每页返回 10 个勋章，页码从 1 开始
      const page = Math.floor(index / 10) + 1

      const { status, canTryNextPage } = await this.fetchMedalPageForLiveStatus(page, roomid)

      if (status !== null) {
        return status
      }

      if (canTryNextPage) {
        await sleep(_.random(300, 500))
        const { status } = await this.fetchMedalPageForLiveStatus(page + 1, roomid)

        return status
      }

      return null
    },
    async (roomid) => {
      try {
        const response = await BAPI.live.getInfoByRoom(roomid)
        console.debug(`BAPI.live.getInfoByRoom(${roomid}) response`, response)
        if (response.code === 0) {
          const liveStatus = response.data.room_info.live_status
          MedalModule.liveStatusSnapshots.set(roomid, { liveStatus, observedAt: tsm() })
          return liveStatus
        }
        console.warn(`BAPI.live.getInfoByRoom(${roomid}) 失败`, response.message)
      } catch (error) {
        console.warn(`BAPI.live.getInfoByRoom(${roomid}) 出错`, error)
      }

      return null
    },
  ]

  /**
   * 将异步请求加入串行队列，相邻请求之间加入随机延迟
   */
  private static enqueueRequest<T>(
    queueKey: RequestQueueKey,
    getDelay: () => Promise<void>,
    requester: () => Promise<T>,
  ): Promise<T> {
    const task = MedalModule.requestQueues[queueKey].catch(() => {}).then(() => requester())
    MedalModule.requestQueues[queueKey] = task.catch(() => {}).then(() => getDelay())
    return task
  }

  /**
   * 将单房间直播状态探测请求加入串行限流队列
   */
  private static enqueueRoomStatusProbe<T>(requester: () => Promise<T>): Promise<T> {
    return MedalModule.enqueueRequest(
      'roomStatus',
      () => sleep(MedalModule.ROOM_STATUS_PROBE_DYNAMIC_DELAY),
      requester,
    )
  }

  /**
   * 获取单个直播间的直播状态
   *
   * @param roomid 直播间号
   * @param preferMedalAPI 是否优先使用粉丝勋章API（其余接口仍随机），默认 false
   */
  private async fetchRoomLiveStatus(
    roomid: number,
    preferMedalAPI = false,
  ): Promise<number | null> {
    const fetchers = preferMedalAPI
      ? [this.ROOM_LIVE_STATUS_FETCHERS[0], ..._.shuffle(this.ROOM_LIVE_STATUS_FETCHERS.slice(1))]
      : _.shuffle(this.ROOM_LIVE_STATUS_FETCHERS)

    for (let i = 0; i < fetchers.length; i++) {
      const liveStatus = await fetchers[i](roomid)
      if (liveStatus !== null) {
        return liveStatus
      }
      if (i < fetchers.length - 1) {
        await sleep(MedalModule.ROOM_STATUS_PROBE_DYNAMIC_DELAY)
      }
    }

    return null
  }

  /**
   * 解析直播间当前的直播状态（执行前校验使用）
   *
   * - 快照仍新鲜：直接复用
   * - 快照过期或不存在：探测并更新快照
   *
   * @param roomid 直播间号
   * @param preferMedalAPI 是否优先使用粉丝勋章API获取直播状态，默认 false
   *
   * @returns 直播状态；探测失败时返回 null
   */
  async resolveLiveStatus(roomid: number, preferMedalAPI = false): Promise<number | null> {
    const snapshot = MedalModule.liveStatusSnapshots.get(roomid)
    if (
      snapshot &&
      tsm() - snapshot.observedAt < MedalModule.LIVE_STATUS_SNAPSHOT_FRESHNESS_THRESHOLD
    ) {
      return snapshot.liveStatus
    }

    return await MedalModule.enqueueRoomStatusProbe(() =>
      this.fetchRoomLiveStatus(roomid, preferMedalAPI),
    )
  }

  /**
   * 获取粉丝勋章任务信息
   * @param targetId 主播的 UID
   * @returns 任务列表，失败返回 null
   */
  static async getTaskInfo(targetId: number): Promise<LiveData.TaskItem[] | null> {
    try {
      const response = await BAPI.live.getActivatedMedalInfo(targetId)
      if (response.code === 0) {
        const data = response.data;
        if (data.reach_free_intimacy_limit) {
          console.warn(`${data.name}(uid: ${targetId}) 已储蓄满${data.free_intimacy}亲密度，无法进行任务`)
          return null
        }
        if (data.task_info) {
          console.debug('BAPI.live.getActivatedMedalInfo response', response)
          return data.task_info
        }
      }
      return null
    } catch (error) {
      console.error('获取任务信息出错:', error)
      return null
    }
  }

  /**
   * 获取指定任务的进度
   * @param targetId 主播的 UID
   * @param title 任务标题
   * @returns [当前进度, 总进度]
   */
  static async getMissionProgress(targetId: number, title: string): Promise<[number, number]> {
    try {
      const targetTask = await MedalModule.getTaskInfo(targetId)
      if (!targetTask) {
        return [0, 0]
      }
      for (const task of targetTask) {
        if (task.title === title) {
          const subTitle = task.sub_title
          const regex = /每日上限\s*(\d+)\/(\d+)/
          const match = subTitle?.match(regex)
          if (match) {
            return [parseInt(match[1], 10), parseInt(match[2], 10)]
          }
          return [0, 0]
        }
      }
    } catch (error) {
      console.error('获取任务进度出错:', error)
    }
    return [0, 0]
  }
}

export default MedalModule
