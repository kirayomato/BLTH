import { useBiliStore, useModuleStore } from '@/stores'
import BAPI from '@/library/bili-api'
import type { LiveData } from '@/library/bili-api/data'
import type { Live } from '@/library/bili-api/response'
import { delayToNextMoment, isTimestampToday } from '@/library/luxon'
import { sleep, CANCELLED_NICK_NAME } from '@/library/utils'
import BaseModule from '@/modules/BaseModule'
import ModuleError from '@/library/error/ModuleError'
import _ from 'lodash'

class FansMedals extends BaseModule {
  /**
   * 获取粉丝勋章
   *
   * @param pages 获取的页数
   */
  static logFansMedals(fansmedal: Live.FansMedalPanel): string {
    if (fansmedal.code != 0)
      return `Error Code: ${fansmedal.code}`
    let result = ""
    const medal_arr = [...fansmedal.data.list, ...fansmedal.data.special_list]
    for (const _list of medal_arr) {
      const medal = _list.medal
      const anchor_info = _list.anchor_info
      result += `${anchor_info.nick_name} / ${medal.medal_name} / Lv.${medal.level}\n`
    }
    return result
  }
  private async getFansMedals(pages = Infinity): Promise<LiveData.FansMedalPanel.List[]> {
    const fansMedalList: LiveData.FansMedalPanel.List[] = []
    let total_page = 1
    try {
      const firstPageResponse = await BAPI.live.fansMedalPanel(1)
      this.logger.debug('BAPI.live.fansMedalPanel(1) response', firstPageResponse)
      this.logger.log("勋章列表(1)\n", FansMedals.logFansMedals(firstPageResponse))
      if (firstPageResponse.code === 0) {
        total_page = firstPageResponse.data.page_info.total_page
        // 第一页的 list 缺少当前佩戴和最近获得的勋章，需通过 special_list 获取
        fansMedalList.push(...firstPageResponse.data.special_list, ...firstPageResponse.data.list)
      } else {
        throw new Error(`获取粉丝勋章列表第1页失败: ${firstPageResponse.message}`)
      }
      for (let page = 2; page <= Math.min(total_page, pages); page++) {
        const response = await BAPI.live.fansMedalPanel(page)
        this.logger.debug(`BAPI.live.fansMedalPanel(${page}) response`, response)
        this.logger.log(`勋章列表((${page})\n`, FansMedals.logFansMedals(response))
        if (response.code !== 0) {
          this.logger.error(`获取粉丝勋章列表第${page}页失败，提前结束获取`, response.message)
          // 中途出错，保留已获取的粉丝勋章列表，不抛出错误
          break
        }
        fansMedalList.push(...response.data.list)
        // 防止风控，稍微加点延时
        await sleep(_.random(300, 500))
      }

      // 服务端分页可能跨页重复或漏条，按房间号去重后与接口报告的总数对账
      const medals = _.uniqBy(fansMedalList, (m) => m.room_info.room_id)
      if (medals.length !== firstPageResponse.data.total_number) {
        this.logger.warn(
          `粉丝勋章数量与接口报告不一致：实际 ${medals.length}，报告 ${firstPageResponse.data.total_number}`,
        )
      }
      return medals
    } catch (error: any) {
      useBiliStore().fansMedalsStatus = 'error'
      throw new ModuleError(this.moduleName, `获取粉丝勋章列表出错: ${error.message}`)
    }
  }

  /**
   * 用粉丝勋章数据自动更新房间名单里的用户名
   *
   * 名单允许用户名留空，运行时获取到粉丝勋章后按房间号补全并保持最新；
   * 账号已注销的保留原名（便于辨认），原名为空才填「账号已注销」；
   * 不在粉丝勋章中的房间保留原名（可能为空）
   *
   * @param medals 刚获取到的粉丝勋章列表
   */
  private syncRoomListNames(medals: LiveData.FansMedalPanel.List[]): void {
    const nameByRoomid = new Map(medals.map((m) => [m.room_info.room_id, m.anchor_info.nick_name]))
    const { roomidList, roomidList2 } = useModuleStore().moduleConfig.DailyTasks.LiveTasks.medalTasks
    for (const entry of [...roomidList, ...roomidList2]) {
      const name = nameByRoomid.get(entry.roomid)
      if (name === undefined) {
        continue
      }
      if (name === CANCELLED_NICK_NAME) {
        if (!entry.name) {
          entry.name = name
        }
      } else if (entry.name !== name) {
        entry.name = name
      }
    }
  }

  public async run(force = false): Promise<void> {
    const biliStore = useBiliStore()

    const medalTasks = useModuleStore().moduleConfig.DailyTasks.LiveTasks.medalTasks
    const taskValues = [medalTasks.light, medalTasks.watch]

    try {
      if (
        (force ||
          // 开启了点亮熄灭勋章或观看直播功能且今天没完成过
          taskValues.some((t) => t.enabled && !isTimestampToday(t._lastCompleteTime, 0, 4))) &&
        // 如果正在获取粉丝勋章，不重复获取
        biliStore.fansMedalsStatus !== 'loading'
      ) {
        biliStore.fansMedalsStatus = 'loading'
        biliStore.fansMedals = await this.getFansMedals()
        biliStore.fansMedalsStatus = 'loaded'
        this.syncRoomListNames(biliStore.fansMedals)
      }
    } finally {
      // 获取失败时也要排下一次，否则一次异常后模块就不再自动重取
      this.nextRunTimer = setTimeout(
        () => this.run().catch((reason) => this.logger.error(reason)),
        delayToNextMoment(0, 4).ms,
      )
    }
  }
}

export default FansMedals
