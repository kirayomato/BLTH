import { delayToNextMoment, isTimestampToday, tsm } from '@/library/luxon'
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

  /** 每个预留直播间每日固定点赞次数 */
  private static readonly RESERVE_LIKE_COUNT = 360
  /** 预留直播间单次点赞请求的点赞次数 */
  private static readonly RESERVE_LIKE_CLICK = 30

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
   * 预留直播间中今日尚未完成的点赞次数，用于在给普通直播间点赞时保留额度
   */
  private getPendingReservedLikes(): number {
    return this.config.reserveLikeRoomids.reduce((total, roomid) => {
      const roomLiked = this.config._todayReserveLikes[String(roomid)] ?? 0
      return total + Math.max(0, LightTask.RESERVE_LIKE_COUNT - roomLiked)
    }, 0)
  }

  /**
   * 为预留直播间点赞，每个直播间每日固定点赞 RESERVE_LIKE_COUNT 次
   *
   * @param medals 点赞列表中属于预留直播间的粉丝勋章
   * @param budget 本次点赞可用的次数上限
   * @returns 本次点赞次数
   */
  private async likeReserved(
    medals: LiveData.FansMedalPanel.List[],
    budget: number,
  ): Promise<number> {
    if (this.config.reserveLikeRoomids.length === 0) return 0

    const medalByRoomid = new Map(medals.map((medal) => [medal.room_info.room_id, medal]))
    let liked = 0

    for (const roomid of this.config.reserveLikeRoomids) {
      if (!this.config.likeEnabled) break
      if (liked >= budget) {
        this.logger.warn('今日点赞额度不足，部分预留直播间未能完成预留点赞')
        break
      }

      const key = String(roomid)
      let roomLiked = this.config._todayReserveLikes[key] ?? 0
      if (roomLiked >= LightTask.RESERVE_LIKE_COUNT) continue

      const medal = medalByRoomid.get(roomid)
      if (!medal) {
        this.logger.warn(`预留直播间（${roomid}）未开播或不在点赞列表中，跳过点赞`)
        continue
      }

      while (roomLiked < LightTask.RESERVE_LIKE_COUNT && liked < budget) {
        if (!this.config.likeEnabled) {
          this.logger.log('点赞开关已关闭，停止点赞任务')
          break
        }
        if ((await this.resolveLiveStatus(roomid)) === 0) {
          this.logger.warn(`预留直播间（${roomid}）已经下播，跳过点赞`)
          break
        }

        const click = Math.min(
          LightTask.RESERVE_LIKE_CLICK,
          LightTask.RESERVE_LIKE_COUNT - roomLiked,
          budget - liked,
        )
        await this.like(medal, click)
        roomLiked += click
        liked += click
        this.config._todayReserveLikes[key] = roomLiked

        if (roomLiked < LightTask.RESERVE_LIKE_COUNT) {
          await sleep(_.random(5e3, 15e3))
        }
      }

      if (roomLiked >= LightTask.RESERVE_LIKE_COUNT) {
        this.logger.log(`预留直播间（${roomid}）今日已点赞 ${roomLiked} 次`)
      }
    }

    return liked
  }

  /**
   * 给正在直播的直播间点赞
   * @param medals
   * @private
   */
  private async likeTask(medals: LiveData.FansMedalPanel.List[]) {
    const BATCH_SIZE = 10;      // 每一批处理多少个
    const DAILY_LIKE_LIMIT = 5000; // 每日点赞上限
    const d = new Date();
    const hours = d.getHours();         // 时
    if (hours < 2) {
      this.logger.log(`0-2点自动跳过点赞任务`)
      return
    }
    // 从持久化配置中读取今日已点赞次数，跨天自动重置
    if (!isTimestampToday(this.config._lastCompleteTime)) {
      this.config._todayLightLikes = 0
      this.config._todayReserveLikes = {}
    }
    let totalLikes = this.config._todayLightLikes

    this.logger.log(`今日已点赞 ${totalLikes} 次（上限 ${DAILY_LIKE_LIMIT}）`)

    if (totalLikes >= DAILY_LIKE_LIMIT) {
      this.logger.log('今日点赞已达上限，跳过点赞任务')
      return
    }

    // 3. 预留直播间优先点赞，剩余额度再分配给普通直播间
    const reserveRoomids = this.config.reserveLikeRoomids
    const reservedMedals = medals.filter((medal) =>
      reserveRoomids.includes(medal.room_info.room_id),
    )
    const normalMedals = medals.filter(
      (medal) => !reserveRoomids.includes(medal.room_info.room_id),
    )
    if (reserveRoomids.length > 0) {
      this.logger.log(`预留直播间(${reserveRoomids.length}): ${reserveRoomids.join(', ')}`)
      const likedForReserved = await this.likeReserved(reservedMedals, DAILY_LIKE_LIMIT - totalLikes)
      totalLikes += likedForReserved
      this.config._todayLightLikes = totalLikes
    }

    // 未完成的预留额度需为对应直播间保留，普通直播间只能使用扣除后的上限
    const pendingReservedLikes = this.getPendingReservedLikes()
    const normalLikeLimit = Math.max(0, DAILY_LIKE_LIMIT - pendingReservedLikes)
    if (pendingReservedLikes > 0) {
      this.logger.log(
        `预留直播间尚有 ${pendingReservedLikes} 次点赞未完成，普通直播间点赞上限为 ${normalLikeLimit} 次`,
      )
    }

    // 1. 切割批次
    const batchList = [];
    for (let i = 0; i < normalMedals.length; i += BATCH_SIZE) {
      batchList.push(normalMedals.slice(i, i + BATCH_SIZE));
    }

    // 2. 按批次执行：每批都跑满12轮
    for (const batch of batchList) {
      if (totalLikes >= normalLikeLimit || !this.config.likeEnabled) break;
      let n = batch.length;
      this.logger.log(`点赞列表(${batch.length}): ${batch.map(medal => medal.anchor_info.nick_name)}`)
      batch.reverse();
      for (let j = 0; j < 12; j++) {
        if (totalLikes >= normalLikeLimit || !this.config.likeEnabled) break;
        for (let i = n - 1; i >= 0; i--) {
          if (!this.config.likeEnabled) {
            this.logger.log('点赞开关已关闭，停止点赞任务')
            break
          }
          if (totalLikes >= normalLikeLimit) break;
          const medal = batch[i];
          let flag = 1;
          const liveStatus = await this.resolveLiveStatus(medal.room_info.room_id);
          if (liveStatus == 0) {
            this.logger.warn(`${medal.anchor_info.nick_name} 已经下播，跳过点赞任务`)
            flag = 0;
          }
          if (medal.medal.is_lighted) {
            const [prog, total] = await MedalModule.getMissionProgress(medal.medal.target_id, "点赞30次")
            this.logger.log(`${medal.anchor_info.nick_name} 点赞进度: ${prog} / ${total}`)
            if (prog == total || j - prog > 2) {
              if (j - prog > 2) {
                this.logger.warn(`${medal.anchor_info.nick_name} 点赞任务进度达到上限`)
              }
              flag = 0;
            }
          }
          if (flag == 0) {
            [batch[i], batch[n - 1]] = [batch[n - 1], batch[i]];
            n--;
            continue
          }
          const likeCount = _.random(30, 40);
          await this.like(medal, likeCount);
          totalLikes += likeCount;
          this.config._todayLightLikes = totalLikes

          await sleep(_.random(5e3, 15e3));
        }
      }
    }
    this.logger.log(`点赞任务已完成，本日总点赞次数: ${totalLikes}`)
    // 点赞任务完成一次执行后自动关闭开关，避免后续重复执行
    // 仅在自然跑完且开关仍开启时关闭；若已被用户中途关闭则不重复操作
    if (medals.length === 0) {
      this.logger.log('没有正在直播的粉丝勋章，点赞开关保持开启')
    } else if (this.config.likeEnabled) {
      this.config.likeEnabled = false
      this.logger.log('点赞任务已完成一次执行，点赞开关已自动关闭')
    }
  }

  /**
   * 在未开播的直播间发弹幕
   * @param medals
   * @private
   */
  private async sendDanmuTask(medals: LiveData.FansMedalPanel.List[]) {
    const BATCH_SIZE = 20;      // 每一批处理多少个
    const d = new Date();
    const hours = d.getHours();         // 时
    if (hours >= 19 && hours < 23) {
      this.logger.log(`19-23点自动跳过弹幕任务`)
      return
    }
    let danmuIndex = 0;

    // 1. 切割批次
    const batchList = [];
    for (let i = 0; i < medals.length; i += BATCH_SIZE) {
      batchList.push(medals.slice(i, i + BATCH_SIZE));
    }

    // 2. 按批次执行：每批都跑满12轮
    for (const batch of batchList) {
      if (!this.config.danmuEnabled) break;
      let n = batch.length;
      this.logger.log(`发送弹幕列表(${batch.length}): ${batch.map(medal => medal.anchor_info.nick_name)}`)
      batch.reverse();
      for (let j = 0; j < 12; j++) {
        if (!this.config.danmuEnabled) break;
        for (let i = n - 1; i >= 0; i--) {
          if (!this.config.danmuEnabled) {
            this.logger.log('弹幕开关已关闭，停止发送弹幕任务')
            break
          }
          const medal = batch[i];
          let flag = 1;
          const liveStatus = await this.resolveLiveStatus(medal.room_info.room_id);
          if (liveStatus == 1) {
            this.logger.warn(`${medal.anchor_info.nick_name} 检测到直播中，跳过发送弹幕任务`)
            flag = 0;
          }
          if (medal.medal.is_lighted) {
            const [prog, total] = await MedalModule.getMissionProgress(medal.medal.target_id, "发弹幕")
            this.logger.log(`${medal.anchor_info.nick_name} 发弹幕进度: ${prog} / ${total}`)
            if (prog == total) {
              flag = 0
            }
          }
          if (flag == 0) {
            [batch[i], batch[n - 1]] = [batch[n - 1], batch[i]];
            n--;
            continue
          }
          const success = await this.sendDanmu(
            medal,
            this.config.danmuList[danmuIndex++ % this.config.danmuList.length]
          );

          const sleep_time = 300 / batch.length * 1e3 + _.random(5e3, 1e4);
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

    const tasks: Promise<void>[] = []
    if (this.config.likeEnabled) {
      tasks.push(this.likeTask(fansMedals.on))
    } else {
      this.logger.log('点赞功能已关闭，跳过点赞任务')
    }
    if (this.config.danmuEnabled) {
      tasks.push(this.sendDanmuTask(fansMedals.off))
    } else {
      this.logger.log('弹幕功能已关闭，跳过发送弹幕任务')
    }

    await Promise.allSettled(tasks)

    this.config._lastCompleteTime = tsm()
    this.status = 'done'
    this.logger.log('点亮熄灭勋章任务已完成')


    const diff = delayToNextMoment()
    this.nextRunTimer = setTimeout(() => this.run(), diff.ms)
    this.logger.log('距离点亮熄灭勋章模块下次运行时间:', diff.str)
  }
}

export default LightTask
