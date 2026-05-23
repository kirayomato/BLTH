import BaseModule from '@/modules/BaseModule'
import { storeToRefs } from 'pinia'
import { useBiliStore, useModuleStore } from '@/stores'
import { watch } from 'vue'
import type { PublicMedalFilters } from './types'
import { arrayToMap } from '@/library/utils'
import type { LiveData } from '@/library/bili-api/data'

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

  static async getTaskInfo(targetId: number): Promise<LiveData.TaskItem[] | null> {
    try {
      const biliStore = useBiliStore();
      const bili_jct = biliStore.cookies!.bili_jct;
      const baseUrl = "https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/GetActivatedMedalInfo";
      const params = new URLSearchParams({
        csrf: bili_jct,
        target_id: targetId.toString(),
        web_location: "0.0"
      });
      const requestUrl = `${baseUrl}?${params.toString()} `;

      // 发起请求
      const response = await fetch(requestUrl, {
        headers: {
          "accept": "*/*",
          "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
          "cache-control": "no-cache",
          "pragma": "no-cache",
          "sec-ch-ua": "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Google Chrome\";v=\"140\"",
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": "\"Windows\"",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site"
        },
        referrer: "https://live.bilibili.com/",
        method: "GET",
        mode: "cors",
        credentials: "include"
      });

      // 检查HTTP响应状态
      if (!response.ok) {
        throw new Error(`请求失败，状态码: ${response.status} `);
      }

      // 解析响应数据
      const data = await response.json();

      // 验证数据结构
      if (!data?.data?.task_info || !Array.isArray(data.data.task_info)) {
        console.log(data);
        throw new Error("响应数据格式异常，缺少task_info数组");
      }

      return data.data.task_info
    }
    catch (error) {
      console.error("处理出错:", error);
      return null;
    }
  }

  static async getMissionProgress(targetId: number, title: string): Promise<[number, number]> {
    try {
      const targetTask = await MedalModule.getTaskInfo(targetId)
      if (!targetTask) {
        console.log("未找到观看任务");
        return [0, 0];
      }
      for (const task of targetTask) {
        if (task.title == title) {
          // 解析sub_title中的x值（匹配类似"每日上限 5/5"格式）
          const subTitle = task.sub_title;
          const regex = /每日上限\s*(\d+)\/(\d+)/;

          const match = subTitle?.match(regex);
          if (match) {
            const firstNumber = parseInt(match[1], 10);
            const secondNumber = parseInt(match[2], 10);
            return [firstNumber, secondNumber];
          } else {
            console.log("sub_title格式不符合预期，无法解析x值", targetTask);
            return [0, 0];
          }
        }
      }
    } catch (error) {
      console.error("处理出错:", error);
    }
    return [0, 0];
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
}

export default MedalModule
