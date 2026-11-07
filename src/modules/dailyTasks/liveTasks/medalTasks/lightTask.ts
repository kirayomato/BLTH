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

  /** 每日点赞提示阈值（只统计已点亮的勋章；给未点亮勋章的点赞不计数。达到后仅提示，不再限制点赞） */
  private static readonly DAILY_LIKE_LIMIT = 5000
  /** 普通直播间每批处理的个数 */
  private static readonly LIKE_BATCH_SIZE = 10
  /** 每个直播间每次点赞的轮数 */
  private static readonly LIKE_ROUNDS = 12
  /**
   * 单次运行中「点赞进度没跟着涨」累计达到该次数后，停止整个点赞任务
   *
   * 单次命中只跳过该房间（与原有逻辑一致）；累计到该次数说明点赞整体不生效，
   * 继续跑下去没有意义。
   */
  private static readonly LIKE_STALL_LIMIT = 5
  /** 点赞任务标题 */
  private static readonly LIKE_MISSION_TITLE = '点赞'
  /** 每日自动点赞的小时（24 小时制） */
  private static readonly AUTO_LIKE_HOUR = 23
  /** 每日自动点赞的分钟 */
  private static readonly AUTO_LIKE_MINUTE = 30

  /** 手动点赞是否正在执行，避免重复触发 */
  private manualLikeRunning = false
  /** 每日自动点赞是否正在执行，避免与手动点赞互相干扰 */
  private autoLikeRunning = false
  /** 每日自动点赞的定时器；模块重新运行时重建，关闭点赞开关时清除 */
  private autoLikeTimer?: number
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

  /**
   * 点赞是否正在执行（手动或每日自动）
   *
   * 控制面板据此禁用点赞按钮：自动点赞期间手动打开选择窗口会与它争抢候选列表。
   *
   * @returns 任意一种点赞流程正在执行时返回 true
   */
  public get isManualLikeRunning(): boolean {
    return this.manualLikeRunning || this.autoLikeRunning
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
          this.medalTasksConfig.roomidList2.some((entry) => entry.roomid === medal.room_info.room_id) ||
          medal.medal.level < 15
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
      // 跨天后停止标记一并清除，新的一天重新允许点赞
      this.config._likeStopped = false
      // 跨天后任务进度重置，之前检查出的房间列表已经过期
      this.checkedRooms = []
    }

    return this.config._todayLightLikes
  }

  /**
   * 今日点赞是否达到提示阈值
   *
   * 计数只统计「已点亮」勋章的点赞：给未点亮的勋章点赞是为了把它点亮，这部分点赞不计数。
   * 达到阈值后仅提示，不再限制点赞。
   *
   * @param totalLikes 今日已计数的点赞次数
   */
  private isLikeLimitReached(totalLikes: number): boolean {
    return totalLikes >= LightTask.DAILY_LIKE_LIMIT
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

      // 每个房间都请求：未点亮也要查，点亮状态会在运行中被点亮或熄灭，快照不可靠。
      // 一次请求同时刷新点亮状态与进度，不额外发请求
      let isLighted = medal.medal.is_lighted === 1
      let likeProgress: number | null = null
      let likeProgressTotal: number | null = null
      const state = await this.fetchMissionState(medal, LightTask.LIKE_MISSION_TITLE)
      isLighted = state.isLighted
      if (isLighted) {
        // 已点亮必须能判断上限：请求失败 / 解析失败 / 储蓄满 一律保守跳过，别白烧额度
        if (!state.available) {
          this.logger.warn(`${nick_name} 勋章信息获取失败，跳过点赞`)
          continue
        }
        if (state.reachFreeIntimacyLimit) {
          continue
        }
        // 任务标题缺失或进度格式变更时同样无法判断上限，保守跳过
        if (state.total == 0) {
          this.logger.warn(`${nick_name} 点赞任务信息不可用，跳过点赞`)
          continue
        }
        this.logger.log(`${nick_name} 点赞进度: ${state.prog} / ${state.total}`)
        if (state.prog >= state.total) {
          this.logger.log(`${nick_name} 点赞任务进度已达到上限，跳过点赞`)
          continue
        }
        likeProgress = state.prog
        likeProgressTotal = state.total
      }

      candidates.push({
        roomid,
        uid: medal.medal.target_id,
        nick_name,
        medal_name: medal.medal.medal_name,
        avatar: medal.anchor_info.avatar,
        medal_level: medal.medal.level,
        is_lighted: isLighted,
        freeIntimacy: state.freeIntimacy,
        reachFreeIntimacyLimit: state.reachFreeIntimacyLimit,
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
   * 今日点赞达到提示阈值时仅提示，不再剔除候选、不再限制点赞。
   *
   * @returns 候选快照（含今日点赞次数与提示阈值）；前置条件不满足时返回 null
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

    // 停止标记是持久化的：一旦本次运行因进度持续未增长而停止，之后再次收集也要拦下，
    // 直到跨天自动恢复（点【再次运行任务】不会清除该标记）
    if (this.config._likeStopped) {
      this.logger.warn('今日点赞任务已停止（点赞进度多次没有增长），明天会自动恢复')
      return null
    }

    this.logger.log(
      `今日已点亮勋章点赞 ${totalLikes} 次（提示阈值 ${LightTask.DAILY_LIKE_LIMIT}，未点亮勋章的点赞不计数）`,
    )

    if (this.isLikeLimitReached(totalLikes)) {
      // 仅提示，不再限制：候选照常返回，点赞照常执行
      this.logger.warn(
        `今日点赞已达到提示阈值 ${LightTask.DAILY_LIKE_LIMIT} 次，继续点赞可能不再产生收益`,
      )
    }

    // 检查过就直接复用，不再逐个房间重新探测
    const candidates =
      this.checkedRooms.length > 0 ? this.checkedRooms : await this.checkLikeRooms()
    if (this.checkedRooms.length > 0) {
      this.logger.log(`${this.checkedRooms.length} 个可以点赞的直播间`)
    }

    return {
      candidates,
      todayLikes: totalLikes,
      dailyLimit: LightTask.DAILY_LIKE_LIMIT,
    }
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
   * 重新获取粉丝勋章
   *
   * 粉丝勋章是启动时的快照，到自动点赞触发时可能已经过去十几个小时：
   * 新关注的主播不会出现在快照里，熄灭的勋章、改过的昵称也不会同步过来，
   * 因此执行前强制刷新一次。沿用 rerunModule 而不是直接调 run，
   * 是为了顺带清掉该模块原有的下次运行定时器，避免重复排期。
   */
  private async reloadFansMedals(): Promise<void> {
    this.logger.log('每日自动点赞：重新获取粉丝勋章')
    try {
      await useModuleStore().rerunModule('Default_FansMedals', true)
    } catch (error) {
      // 失败时保留原快照，后续 waitForFansMedals 会按实际状态决定能否继续
      this.logger.error('每日自动点赞：重新获取粉丝勋章失败，沿用当前快照', error)
    }
  }

  /**
   * 按默认勾选规则自动执行一次点赞
   *
   * 默认勾选规则与手动点赞窗口保持一致：亲密度储蓄已满的勋章不勾选
   * （点赞不再涨亲密度），其余候选全部勾选。
   *
   * 执行前会重新获取粉丝勋章并重新探测候选：快照与候选都是模块初始化时查的，
   * 可能与触发时间隔了十几个小时。
   */
  private async autoLikeWithDefaults(): Promise<void> {
    if (this.autoLikeRunning) {
      this.logger.warn('每日自动点赞正在运行中，忽略本次触发')
      return
    }
    if (this.manualLikeRunning) {
      this.logger.warn('手动点赞正在运行中，跳过本次每日自动点赞')
      return
    }

    this.autoLikeRunning = true
    try {
      // 先刷新粉丝勋章，后面探测候选、执行点赞用的都是最新数据
      await this.reloadFansMedals()

      this.checkedRooms = []

      const snapshot = await this.collectLikeCandidates()
      if (!snapshot) {
        // 前置条件不满足（开关关闭 / 今日已停止等），collectLikeCandidates 已记录原因
        return
      }
      if (snapshot.candidates.length === 0) {
        this.logger.log('每日自动点赞：没有可以点赞的直播间')
        return
      }

      // 默认勾选规则：亲密度储蓄已满的勋章不勾选
      const roomids = snapshot.candidates
        .filter((room) => !room.reachFreeIntimacyLimit)
        .map((room) => room.roomid)
      if (roomids.length === 0) {
        this.logger.log('每日自动点赞：按默认勾选规则没有需要点赞的直播间')
        return
      }

      this.logger.log(
        `每日自动点赞：候选 ${snapshot.candidates.length} 个直播间，按默认勾选规则选中 ${roomids.length} 个`,
      )
      await this.likeRooms(roomids)
    } catch (error) {
      this.logger.error('每日自动点赞执行出错', error)
    } finally {
      this.autoLikeRunning = false
    }
  }

  /**
   * 安排下一次每日自动点赞
   *
   * 每次 run() 都会重新安排，页面刷新或模块被重跑时旧定时器先被清除；
   * 点赞开关关闭时不安排，避免按钮关掉后仍然自动点赞。
   */
  private scheduleAutoLike(): void {
    if (this.autoLikeTimer) {
      clearTimeout(this.autoLikeTimer)
      this.autoLikeTimer = undefined
    }
    if (!this.config.likeEnabled) return

    const diff = delayToNextMoment(LightTask.AUTO_LIKE_HOUR, LightTask.AUTO_LIKE_MINUTE)
    this.autoLikeTimer = setTimeout(() => {
      // 定时器已触发，先清空再进入下一轮
      this.autoLikeTimer = undefined
      void this.autoLikeWithDefaults()
    }, diff.ms)

    this.logger.log(
      `每日自动点赞已安排（${LightTask.AUTO_LIKE_HOUR}:${String(LightTask.AUTO_LIKE_MINUTE).padStart(2, '0')}），距下次还有 ${diff.str}`,
    )
  }

  /**
   * 为指定直播间执行点赞
   *
   * 收集列表时的检查结果只用于初筛；真正点赞时每轮都会重新确认直播状态与
   * 「点赞30次」进度，已经下播或任务完成的房间会被移出本批。
   *
   * 今日点赞达到提示阈值后仅提示，不再跳过任何勋章；
   * 「点赞进度没有增长」单次命中照旧跳过该房间，
   * 单次运行中累计达到阈值后停止整个点赞任务。
   *
   * @param roomids 要执行点赞的直播间号
   */
  private async executeLike(roomids: number[]): Promise<void> {
    let totalLikes = this.syncDailyLikeState()

    // 停止标记是持久化的：只有跨天才会自动清除
    if (this.config._likeStopped) {
      this.logger.warn('今日点赞任务已停止（点赞进度多次没有增长），明天会自动恢复')
      return
    }

    this.logger.log(
      `今日已点亮勋章点赞 ${totalLikes} 次（提示阈值 ${LightTask.DAILY_LIKE_LIMIT}，未点亮勋章的点赞不计数）`,
    )

    /** 本次执行是否已经提示过阈值，达到后只提示一次 */
    let limitNoticed = this.isLikeLimitReached(totalLikes)
    if (limitNoticed) {
      // 仅提示，不限制：所有勋章照常点赞
      this.logger.warn(
        `今日点赞已达到提示阈值 ${LightTask.DAILY_LIKE_LIMIT} 次，继续点赞可能不再产生收益`,
      )
    }

    /**
     * 本次运行中「点赞进度没有增长」的累计次数
     *
     * 单次命中只跳过该房间（与原有逻辑一致）；累计达到阈值说明点赞整体不生效，
     * 此时停止整个点赞任务（写回配置，跨天或再次运行任务时清除）。
     */
    let stallCount = 0

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
      if (!this.config.likeEnabled || this.config._likeStopped) break
      let n = batch.length
      this.logger.log(
        `点赞列表(${batch.length}): ${batch.map((medal) => medal.anchor_info.nick_name)}`,
      )
      batch.reverse()

      for (let j = 0; j < LightTask.LIKE_ROUNDS; j++) {
        if (n === 0) break
        if (!this.config.likeEnabled || this.config._likeStopped) break
        for (let i = n - 1; i >= 0; i--) {
          if (!this.config.likeEnabled) {
            this.logger.log('点赞开关已关闭，停止点赞任务')
            break
          }
          if (this.config._likeStopped) break

          const medal = batch[i]
          let skip = false
          /** 本次点赞是否计入今日计数：只有已点亮的勋章才计数 */
          let countLike = medal.medal.is_lighted === 1

          const liveStatus = await this.resolveLiveStatus(medal.room_info.room_id)
          if (liveStatus === 0) {
            this.logger.warn(`${medal.anchor_info.nick_name} 已经下播，跳过点赞任务`)
            skip = true
          }

          if (!skip) {
            // 每轮都请求：未点亮也要查，点赞过程中房间可能已被点亮，计数状态要跟着更新。
            // 已点亮时只要信息不可用（请求失败 / 解析失败 / 储蓄满）就跳过，别白烧
            const state = await this.fetchMissionState(medal, LightTask.LIKE_MISSION_TITLE)
            countLike = state.isLighted

            if (state.isLighted) {
              if (!state.available) {
                this.logger.warn(`${medal.anchor_info.nick_name} 勋章信息获取失败，跳过点赞任务`)
                skip = true
              } else if (state.reachFreeIntimacyLimit) {
                skip = true
              } else if (state.total == 0) {
                this.logger.warn(`${medal.anchor_info.nick_name} 点赞任务信息不可用，跳过点赞任务`)
                skip = true
              } else {
                this.logger.log(
                  `${medal.anchor_info.nick_name} 点赞进度: ${state.prog} / ${state.total}`,
                )
                // 已跑满：任务完成，不再点赞
                if (state.prog >= state.total) {
                  skip = true
                } else if (j - state.prog > 2) {
                  // 进度没跟着涨（点赞暂时没生效）：跳过该房间（与原有逻辑一致）；
                  // 单次运行中累计达到阈值说明点赞整体不生效，停止整个点赞任务
                  stallCount++
                  this.logger.warn(
                    `${medal.anchor_info.nick_name} 点赞任务进度没有增长（本次运行累计 ${stallCount}/${LightTask.LIKE_STALL_LIMIT} 次），跳过点赞任务`,
                  )
                  skip = true
                  if (stallCount >= LightTask.LIKE_STALL_LIMIT) {
                    this.config._likeStopped = true
                    this.logger.warn(
                      `本次运行点赞进度已累计 ${stallCount} 次没有增长，点赞整体不生效，停止整个点赞任务`,
                    )
                  }
                }
              }
            }
            // 未点亮时无需判断：点赞本身就是为重新点亮，照常执行且不计数
          }

          if (skip) {
            // 换到批尾并缩小遍历范围，本批后续轮次不再处理该房间
            ;[batch[i], batch[n - 1]] = [batch[n - 1], batch[i]]
            n--
            continue
          }

          const likeCount = _.random(30, 40)
          await this.like(medal, likeCount)

          if (countLike) {
            totalLikes += likeCount
            this.config._todayLightLikes = totalLikes
            if (!limitNoticed && this.isLikeLimitReached(totalLikes)) {
              limitNoticed = true
              this.logger.warn(
                `今日点赞已达到提示阈值 ${LightTask.DAILY_LIKE_LIMIT} 次，继续点赞可能不再产生收益`,
              )
            }
          } else {
            // 未点亮勋章的点赞不计数
            this.logger.debug(
              `${medal.anchor_info.nick_name} 勋章未点亮，本次点赞 ${likeCount} 次不计入今日计数`,
            )
          }

          await sleep(_.random(5e3, 15e3))
        }
      }
    }

    // 这一轮点赞改变了任务进度，下次收集需要重新检查
    this.checkedRooms = []

    if (this.config._likeStopped) {
      this.logger.warn(
        `点赞任务已停止（进度累计 ${stallCount} 次没有增长），今日已点亮勋章点赞 ${totalLikes} 次`,
      )
    } else {
      this.logger.log(`点赞任务已完成，今日已点亮勋章点赞 ${totalLikes} 次`)
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
          // 未点亮也要请求：顺便刷新点亮状态，只有真的已点亮才需要判断上限
          if (flag !== 0) {
            const state = await this.fetchMissionState(medal, '弹幕')
            if (state.isLighted) {
              // 已点亮：请求失败 / 解析失败 / 储蓄满 / 已跑满 都跳过
              if (!state.available) {
                this.logger.warn(`${medal.anchor_info.nick_name} 勋章信息获取失败，跳过发送弹幕`)
                flag = 0
              } else if (state.reachFreeIntimacyLimit) {
                flag = 0
              } else if (state.total == 0) {
                this.logger.warn(
                  `${medal.anchor_info.nick_name} 发弹幕任务信息不可用，跳过发送弹幕`,
                )
                flag = 0
              } else {
                this.logger.log(
                  `${medal.anchor_info.nick_name} 发弹幕进度: ${state.prog} / ${state.total}`,
                )
                if (state.prog >= state.total) {
                  flag = 0
                }
              }
            }
            // 未点亮时无需判断上限：发弹幕本身就是为重新点亮
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

    // 登记每日自动点赞：即使点赞开关关闭也要先清掉旧定时器，避免关掉后仍自动点赞
    this.scheduleAutoLike()

    const tasks: Promise<void>[] = []
    if (this.config.likeEnabled) {
      // 点赞默认手动运行，但候选直播间在这里（初始化时）就查好：
      // 面板点【选择直播间点赞】直接展示结果，不用现查一遍
      this.syncDailyLikeState()
      if (this.config._likeStopped) {
        // 今日点赞已整体停止：不再探测候选，等跨天自动恢复
        this.logger.log('今日点赞任务已停止，跳过点赞列表检查')
      } else {
        tasks.push(this.checkLikeRooms().then(() => undefined))
      }
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
