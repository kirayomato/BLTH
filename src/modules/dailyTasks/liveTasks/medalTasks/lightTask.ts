import { delayToNextMoment, isTimestampToday, tsm } from '@/library/luxon'
import BAPI from '@/library/bili-api'
import { useBiliStore, useModuleStore } from '@/stores'
import { sleep } from '@/library/utils'
import type { ModuleStatusTypes } from '@/types'
import _ from 'lodash'
import MedalModule from '@/modules/dailyTasks/liveTasks/medalTasks/MedalModule'
import type {
  LightTaskMedalFilters,
  LikeCandidateSnapshot,
  LikeRoomCandidate,
  MedalsByLivingStatus,
} from './types'
import type { LiveData } from '@/library/bili-api/data'

class LightTask extends MedalModule {
  config = this.medalTasksConfig.light

  /** 每日点赞上限 */
  private static readonly DAILY_LIKE_LIMIT = 5000
  /** 普通直播间每批处理的个数 */
  private static readonly LIKE_BATCH_SIZE = 10
  /** 每个直播间每次点赞的轮数 */
  private static readonly LIKE_ROUNDS = 12
  /** 点赞任务标题 */
  private static readonly LIKE_MISSION_TITLE = '点赞30次'

  /** 手动点赞是否正在执行，避免重复触发 */
  private manualLikeRunning = false
  /**
   * 上一次检查得到的可点赞直播间
   *
   * 直播状态与「点赞30次」进度在获取列表时查一次，用于填充选择窗口并做初筛；
   * 真正点赞时每个房间每一轮都会重新确认，不再依赖这份结果。
   */
  private checkedRooms: LikeRoomCandidate[] = []

  set status(s: ModuleStatusTypes) {
    useModuleStore().moduleStatus.DailyTasks.LiveTasks.medalTasks.light = s
  }

  /** 手动点赞是否正在执行 */
  public get isManualLikeRunning(): boolean {
    return this.manualLikeRunning
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
   * 跨天时重置今日点赞计数
   *
   * 用 `_lastLikeTime` 而不是 `_lastCompleteTime` 判断：后者每轮模块运行都会更新，
   * 手动点赞时几乎总是「今天」，会导致今日计数永不重置。
   *
   * @returns 今日已点赞次数
   */
  private syncDailyLikeState(): number {
    if (!isTimestampToday(this.config._lastLikeTime ?? 0)) {
      this.config._todayLightLikes = 0
      this.config._lastLikeTime = tsm()
      // 跨天后任务进度重置，之前检查出的房间列表已经过期
      this.checkedRooms = []
    }

    return this.config._todayLightLikes
  }

  /**
   * 检查可以点赞的直播间
   *
   * 直播状态与「点赞30次」进度在这里查一次，结果保存在 checkedRooms 中，
   * 供选择窗口展示与执行前的初筛；点赞过程中还会逐轮重新确认。
   *
   * @returns 可点赞的直播间列表
   */
  private async checkLikeRooms(): Promise<LikeRoomCandidate[]> {
    const medals = this.getMedals().on
    const candidates: LikeRoomCandidate[] = []

    this.logger.log(`开始检查 ${medals.length} 个直播间是否可以点赞`)
    for (const medal of medals) {
      if (!this.config.likeEnabled) {
        this.logger.log('点赞开关已关闭，停止检查点赞列表')
        break
      }

      const roomid = medal.room_info.room_id
      const nick_name = medal.anchor_info.nick_name

      const liveStatus = await this.resolveLiveStatus(roomid)
      if (liveStatus === 0) {
        this.logger.warn(`${nick_name} 已经下播，跳过点赞`)
        continue
      }

      // 未点亮的勋章不查任务进度：此时点赞是为了重新点亮，不受每日任务上限约束
      let likeProgress: number | null = null
      let likeProgressTotal: number | null = null
      if (medal.medal.is_lighted) {
        const [prog, total] = await MedalModule.getMissionProgress(
          medal.medal.target_id,
          LightTask.LIKE_MISSION_TITLE,
        )
        this.logger.log(`${nick_name} 点赞进度: ${prog} / ${total}`)
        if (total > 0 && prog >= total) {
          this.logger.warn(`${nick_name} 点赞任务进度已达到上限，跳过点赞`)
          continue
        }
        likeProgress = prog
        likeProgressTotal = total
      }

      candidates.push({
        roomid,
        nick_name,
        medal_name: medal.medal.medal_name,
        avatar: medal.anchor_info.avatar,
        medal_level: medal.medal.level,
        is_lighted: medal.medal.is_lighted === 1,
        likeProgress,
        likeProgressTotal,
      })
    }

    this.checkedRooms = candidates
    this.logger.log(`共找到 ${candidates.length} 个可以点赞的直播间`)
    return candidates
  }

  /**
   * 收集当前可以点赞的直播间
   *
   * 检查只做一次：已经检查过的结果会一直复用，窗口反复开关、重复点按钮都不会
   * 重新探测房间；点赞执行完成后结果被清空，下次再点按钮才会重新检查。
   *
   * @returns 候选快照（含今日点赞次数与上限）；前置条件不满足时返回 null
   */
  public async collectLikeCandidates(): Promise<LikeCandidateSnapshot | null> {
    if (!this.config.enabled) {
      this.logger.warn('点亮熄灭勋章开关未开启，无法点赞')
      return null
    }
    if (!this.config.likeEnabled) {
      this.logger.warn('点赞开关已关闭，无法点赞')
      return null
    }
    if (!(await this.waitForFansMedals())) {
      this.logger.error('粉丝勋章数据不存在，无法点赞')
      return null
    }

    const totalLikes = this.syncDailyLikeState()
    this.logger.log(`今日已点赞 ${totalLikes} 次（上限 ${LightTask.DAILY_LIKE_LIMIT}）`)

    if (totalLikes >= LightTask.DAILY_LIKE_LIMIT) {
      this.logger.log('今日点赞已达上限，无法点赞')
      return null
    }

    // 检查过就直接复用，不再逐个房间重新探测
    if (this.checkedRooms.length > 0) {
      this.logger.log(`${this.checkedRooms.length} 个可以点赞的直播间`)
      return {
        candidates: this.checkedRooms,
        todayLikes: totalLikes,
        dailyLimit: LightTask.DAILY_LIKE_LIMIT,
      }
    }

    const candidates = await this.checkLikeRooms()

    return { candidates, todayLikes: totalLikes, dailyLimit: LightTask.DAILY_LIKE_LIMIT }
  }

  /**
   * 为指定直播间点赞
   *
   * 控制面板与独立运行版的配置页面都走这条链路（页面负责收集候选并选择房间，
   * 模块只执行点赞）。
   *
   * @param roomids 要执行点赞的直播间号
   */
  public async likeRooms(roomids: number[]): Promise<void> {
    if (this.manualLikeRunning) {
      this.logger.warn('点赞任务正在运行中，忽略本次触发')
      return
    }

    this.manualLikeRunning = true
    try {
      await this.executeLike(roomids)
    } finally {
      this.manualLikeRunning = false
    }
  }

  /**
   * 为指定直播间执行点赞
   *
   * 收集列表时的检查结果只用于初筛；真正点赞时每轮都会重新确认直播状态与
   * 「点赞30次」进度，已经下播或任务完成的房间会被移出本批。
   *
   * @param roomids 要执行点赞的直播间号
   */
  private async executeLike(roomids: number[]): Promise<void> {
    let totalLikes = this.syncDailyLikeState()

    this.logger.log(`今日已点赞 ${totalLikes} 次（上限 ${LightTask.DAILY_LIKE_LIMIT}）`)

    if (totalLikes >= LightTask.DAILY_LIKE_LIMIT) {
      this.logger.log('今日点赞已达上限，跳过点赞任务')
      return
    }
    if (roomids.length === 0) {
      this.logger.log('没有选择任何直播间，跳过点赞任务')
      return
    }

    if (this.checkedRooms.length === 0) {
      await this.checkLikeRooms()
    }

    const checked = new Set(this.checkedRooms.map((room) => room.roomid))
    const wantedRoomids = roomids.filter((roomid) => checked.has(roomid))
    if (wantedRoomids.length !== roomids.length) {
      this.logger.warn(
        `${roomids.length - wantedRoomids.length} 个直播间未通过检查（已下播或任务已完成），跳过点赞`,
      )
    }
    if (wantedRoomids.length === 0) {
      this.logger.log('没有符合条件的直播间，跳过点赞任务')
      return
    }

    const medalByRoomid = new Map(
      this.getMedals().on.map((medal) => [medal.room_info.room_id, medal]),
    )

    const medals = wantedRoomids
      .map((roomid) => medalByRoomid.get(roomid))
      .filter((medal): medal is LiveData.FansMedalPanel.List => Boolean(medal))

    // 1. 切割批次
    const batchList: LiveData.FansMedalPanel.List[][] = []
    for (let i = 0; i < medals.length; i += LightTask.LIKE_BATCH_SIZE) {
      batchList.push(medals.slice(i, i + LightTask.LIKE_BATCH_SIZE))
    }

    // 2. 按批次执行：每批都跑满 12 轮，每轮跑之前重新确认房间状态与任务进度
    for (const batch of batchList) {
      if (totalLikes >= LightTask.DAILY_LIKE_LIMIT || !this.config.likeEnabled) break
      let n = batch.length
      this.logger.log(
        `点赞列表(${batch.length}): ${batch.map((medal) => medal.anchor_info.nick_name)}`,
      )
      batch.reverse()

      for (let j = 0; j < LightTask.LIKE_ROUNDS; j++) {
        if (n === 0) break
        if (totalLikes >= LightTask.DAILY_LIKE_LIMIT || !this.config.likeEnabled) break
        for (let i = n - 1; i >= 0; i--) {
          if (!this.config.likeEnabled) {
            this.logger.log('点赞开关已关闭，停止点赞任务')
            break
          }
          if (totalLikes >= LightTask.DAILY_LIKE_LIMIT) break

          const medal = batch[i]
          let skip = false

          const liveStatus = await this.resolveLiveStatus(medal.room_info.room_id)
          if (liveStatus === 0) {
            this.logger.warn(`${medal.anchor_info.nick_name} 已经下播，跳过点赞任务`)
            skip = true
          }

          if (!skip && medal.medal.is_lighted) {
            const [prog, total] = await MedalModule.getMissionProgress(
              medal.medal.target_id,
              LightTask.LIKE_MISSION_TITLE,
            )
            this.logger.log(`${medal.anchor_info.nick_name} 点赞进度: ${prog} / ${total}`)
            // 已跑满，或连续多轮进度没跟着涨（点赞不生效）就放弃该房间
            if (prog === total || j - prog > 2) {
              if (j - prog > 2) {
                this.logger.warn(`${medal.anchor_info.nick_name} 点赞任务进度达到上限`)
              }
              skip = true
            }
          }

          if (skip) {
            // 换到批尾并缩小遍历范围，本批后续轮次不再处理该房间
            ;[batch[i], batch[n - 1]] = [batch[n - 1], batch[i]]
            n--
            continue
          }

          const likeCount = _.random(30, 40)
          await this.like(medal, likeCount)
          totalLikes += likeCount
          this.config._todayLightLikes = totalLikes

          await sleep(_.random(5e3, 15e3))
        }
      }
    }

    // 这一轮点赞改变了任务进度，下次收集需要重新检查
    this.checkedRooms = []

    this.logger.log(`点赞任务已完成，本日总点赞次数: ${totalLikes}`)
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
      // 点赞改为手动运行，但候选直播间在这里（初始化时）就查好：
      // 面板点【选择直播间点赞】直接展示结果，不用现查一遍
      this.syncDailyLikeState()
      tasks.push(this.checkLikeRooms().then(() => undefined))

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
