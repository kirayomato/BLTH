import { delayToNextMoment, tsm } from '@/library/luxon'
import BAPI from '@/library/bili-api'
import { useBiliStore, useModuleStore } from '@/stores'
import { sleep } from '@/library/utils'
import type { ModuleStatusTypes } from '@/types'
import _ from 'lodash'
import MedalModule from '@/modules/dailyTasks/liveTasks/medalTasks/MedalModule'
import type { LightTaskMedalFilters, MedalsByLivingStatus } from './types'
import type { LiveData } from '@/library/bili-api/data'

class LightTask extends MedalModule {
  config = this.medalTasksConfig.light

  set status(s: ModuleStatusTypes) {
    useModuleStore().moduleStatus.DailyTasks.LiveTasks.medalTasks.light = s
  }

  private MEDAL_FILTERS: LightTaskMedalFilters = {
    // 点亮返回true，否则返回false
    isLighted: (medal) => medal.medal.is_lighted === 1,
    // 直播中返回on，否则返回off
    livingStatus: (medal) => (medal.room_info.living_status === 1 ? 'on' : 'off'),
  }

  /**
   * 获取粉丝勋章
   * @returns 根据直播状态划分、经过排序和过滤的粉丝勋章
   */
  private getMedals(): MedalsByLivingStatus {
    const fansMedals = useBiliStore().filteredFansMedals

    const result: MedalsByLivingStatus = {
      on: [],
      off: [],
    }

    const idlist = fansMedals.filter(
      (medal) => this.PUBLIC_MEDAL_FILTERS.whiteBlackList(medal)
        &&
        (
          this.MEDAL_FILTERS.livingStatus(medal) == "on" ||
          this.medalTasksConfig.roomidList2.includes(medal.room_info.room_id)
        )
    );
    idlist.forEach((medal) => {
      const livingStatus = this.MEDAL_FILTERS.livingStatus(medal);
      result[livingStatus].push(medal);
    });

    result.on.sort(this.sort_live_medals);
    result.off.sort(this.sort_live_medals);

    return result;
  }

  /**
   * 点赞
   * @param medal 粉丝勋章
   * @param click_time 点赞次数
   */
  private async like(medal: LiveData.FansMedalPanel.List, click_time: number): Promise<void> {
    const room_id = medal.room_info.room_id
    const target_id = medal.medal.target_id
    const nick_name = medal.anchor_info.nick_name
    const medal_name = medal.medal.medal_name
    const logMessage = `粉丝勋章【${medal_name}】 给主播【${nick_name}】（UID：${target_id}）的直播间（${room_id}）点赞 ${click_time} 次`

    try {
      const response = await BAPI.live.likeReport(room_id, target_id, click_time)
      this.logger.debug(`BAPI.live.likeReport(${room_id}, ${target_id}, ${click_time})`, response)
      if (response.code === 0) {
        this.logger.log(`点亮熄灭勋章-点赞 ${logMessage} 成功`)
      } else {
        this.logger.error(`点亮熄灭勋章-点赞 ${logMessage} 失败`, response.message)
      }
    } catch (error) {
      this.logger.error(`点亮熄灭勋章-点赞 ${logMessage} 出错`, error)
    }
  }

  /**
   * 发弹幕
   * @param medal 粉丝勋章
   * @param danmu 弹幕内容
   */
  private async sendDanmu(medal: LiveData.FansMedalPanel.List, danmu: string): Promise<boolean> {
    const room_id = medal.room_info.room_id
    const target_id = medal.medal.target_id
    const nick_name = medal.anchor_info.nick_name
    const medal_name = medal.medal.medal_name
    const logMessage = `粉丝勋章【${medal_name}】 在主播【${nick_name}】（UID：${target_id}）的直播间（${room_id}）发送弹幕 ${danmu}`

    try {
      const response = await BAPI.live.sendMsg(danmu, room_id)
      this.logger.debug(`BAPI.live.sendMsg(${danmu}, ${room_id})`, response)
      if (response.code === 0) {
        if (response.msg === 'k') {
          this.logger.warn(`点亮熄灭勋章-发送弹幕 ${logMessage} 异常，弹幕可能包含屏蔽词`)
        } else {
          this.logger.log(`点亮熄灭勋章-发送弹幕 ${logMessage} 成功`)
          return true
        }
      } else {
        this.logger.error(`点亮熄灭勋章-发送弹幕 ${logMessage} 失败`, response.message)
      }
    } catch (error) {
      this.logger.error(`点亮熄灭勋章-发送弹幕 ${logMessage} 出错`, error)
    }

    return false
  }
  private async sendEmoji(medal: LiveData.FansMedalPanel.List, emoji: string): Promise<boolean> {
    const room_id = medal.room_info.room_id;
    const target_id = medal.medal.target_id;
    const nick_name = medal.anchor_info.nick_name;
    const medal_name = medal.medal.medal_name;
    const logMessage = `粉丝勋章【${medal_name}】 在主播【${nick_name}】（UID：${target_id}）的直播间（${room_id}）发送表情 ${emoji}`;
    try {
      const response = await BAPI.live.sendEmoji(emoji, room_id);
      this.logger.debug(`BAPI.live.sendEmoji(${emoji}, ${room_id})`, response);
      if (response.code === 0) {
        if (response.msg === "k") {
          this.logger.warn(`点亮熄灭勋章-发送表情 ${logMessage} 异常，表情可能包含屏蔽词`);
        } else {
          this.logger.log(`点亮熄灭勋章-发送表情 ${logMessage} 成功`);
          return true;
        }
      } else {
        this.logger.error(`点亮熄灭勋章-发送表情 ${logMessage} 失败`, response.message);
      }
    } catch (error) {
      this.logger.error(`点亮熄灭勋章-发送表情 ${logMessage} 出错`, error);
    }
    return false;
  }
  /**
   * 给正在直播的直播间点赞
   * @param medals
   * @private
   */
  private async likeTask(medals: LiveData.FansMedalPanel.List[]) {
    const BATCH_SIZE = 10;      // 每一批处理多少个

    // 1. 切割批次
    const batchList = [];
    for (let i = 0; i < medals.length; i += BATCH_SIZE) {
      batchList.push(medals.slice(i, i + BATCH_SIZE));
    }

    // 2. 按批次执行：每批都跑满12轮
    for (const batch of batchList) {
      let n = batch.length;
      this.logger.log(`点赞列表(${batch.length}): ${batch.map(medal => medal.anchor_info.nick_name)}`)
      batch.reverse();
      for (let j = 0; j < 12; j++) {
        for (let i = n - 1; i >= 0; i--) {
          const medal = batch[i];
          if (medal.medal.is_lighted) {
            const [prog, total] = await MedalModule.getMissionProgress(medal.medal.target_id, "点赞30次")
            this.logger.log(`${medal.anchor_info.nick_name} 点赞进度: ${prog} / ${total}`)
            if (prog == total || j - prog > 3) {
              [batch[i], batch[n - 1]] = [batch[n - 1], batch[i]];
              n--;
              continue
            }
          }
          await this.like(medal, _.random(30, 40));

          await sleep(_.random(5e3, 15e3));
        }
      }
    }
    this.logger.log('点赞任务已完成')
  }

  /**
   * 在未开播的直播间发弹幕
   * @param medals
   * @private
   */
  private async sendDanmuTask(medals: LiveData.FansMedalPanel.List[]) {
    const BATCH_SIZE = 20;      // 每一批处理多少个

    let danmuIndex = 0;

    // 1. 切割批次
    const batchList = [];
    for (let i = 0; i < medals.length; i += BATCH_SIZE) {
      batchList.push(medals.slice(i, i + BATCH_SIZE));
    }

    // 2. 按批次执行：每批都跑满12轮
    for (const batch of batchList) {
      let n = batch.length;
      this.logger.log(`发送弹幕列表(${batch.length}): ${batch.map(medal => medal.anchor_info.nick_name)}`)
      batch.reverse();
      for (let j = 0; j < 12; j++) {
        for (let i = n - 1; i >= 0; i--) {
          const medal = batch[i];
          if (medal.medal.is_lighted) {
            const [prog, total] = await MedalModule.getMissionProgress(medal.medal.target_id, "发弹幕")
            this.logger.log(`${medal.anchor_info.nick_name} 发弹幕进度: ${prog} / ${total}`)
            if (prog == total) {
              [batch[i], batch[n - 1]] = [batch[n - 1], batch[i]];
              n--;
              continue
            }
          }
          const success = await this.sendDanmu(
            medal,
            this.config.danmuList[danmuIndex++ % this.config.danmuList.length]
          );

          const sleep_time = 300 / batch.length * 1e3 + _.random(1e4, 3e4);
          if (!success) {
            await sleep(sleep_time);
            await this.sendEmoji(
              medal,
              this.config.emojiList[danmuIndex++ % this.config.emojiList.length]
            );
          }

          await sleep(sleep_time);
        }
      }
    }
    this.logger.log('发送弹幕任务已完成')
  }

  public async run(): Promise<void> {
    this.logger.log('点亮熄灭勋章模块开始运行')

    if (!(await this.waitForFansMedals())) {
      this.logger.error('粉丝勋章数据不存在，不执行点亮熄灭勋章任务')
      this.status = 'error'
      return
    }

    this.status = 'running'
    const fansMedals = this.getMedals()

    await Promise.allSettled([this.likeTask(fansMedals.on), this.sendDanmuTask(fansMedals.off)])

    this.config._lastCompleteTime = tsm()
    this.status = 'done'
    this.logger.log('点亮熄灭勋章任务已完成')


    const diff = delayToNextMoment()
    this.nextRunTimer = setTimeout(() => this.run(), diff.ms)
    this.logger.log('距离点亮熄灭勋章模块下次运行时间:', diff.str)
  }
}

export default LightTask
