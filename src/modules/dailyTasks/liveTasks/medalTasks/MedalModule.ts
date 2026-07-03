import BaseModule from '@/modules/BaseModule'
import { storeToRefs } from 'pinia'
import { useBiliStore, useModuleStore } from '@/stores'
import { watch } from 'vue'
import type { PublicMedalFilters } from './types'
import { arrayToMap } from '@/library/utils'
import type { LiveData } from '@/library/bili-api/data'
import BAPI from '@/library/bili-api'

class MedalModule extends BaseModule {
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
