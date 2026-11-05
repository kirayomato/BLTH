import { delayToNextMoment, isNowIn, tsm } from '@/library/luxon'
import BAPI from '@/library/bili-api'
import { useBiliStore, useModuleStore, usePlayerStore } from '@/stores'
import Logger from '@/library/logger'
import CryptoJS from 'crypto-js'
import { sleep, uuid } from '@/library/utils'
import type { ModuleConfig, ModuleStatusTypes, RunAtMoment } from '@/types'
import MedalModule from '@/modules/dailyTasks/liveTasks/medalTasks/MedalModule'
import type { LiveData } from '@/library/bili-api/data'

interface SpyderData {
  benchmark: string
  device: string
  ets: number
  id: string
  time: number
  ts: number
  ua: string
}

class RoomHeart {
  constructor(
    roomID: number,
    uname: string,
    areaID: number,
    parentID: number,
    ruid: number,
    watchMinutes: number,
    initialProgress: number
  ) {
    this.roomID = roomID
    this.areaID = areaID
    this.parentID = parentID
    this.ruid = ruid
    this.config = useModuleStore().moduleConfig.DailyTasks.LiveTasks.medalTasks.watch
    this.uname = uname
    this.watchMinutes = watchMinutes
    this.initialProgress = initialProgress
    // 15分钟折算1点进度
    this.targetProgress = watchMinutes / 15
    // 未达到目标进度时，最多观看规划时长+15分钟
    this.maxWatchSeconds = (watchMinutes + 15) * 60
  }

  private logger = new Logger('RoomHeart')

  private config: ModuleConfig['DailyTasks']['LiveTasks']['medalTasks']['watch']
  private watchMinutes: number
  /** 本次观看开始前的进度，目标进度按本次观看的新增量计算 */
  private readonly initialProgress: number
  /** 本次观看所需达成的进度增量，由观看时长折算（15分钟1点），达到即停止观看 */
  private readonly targetProgress: number
  /** 观看时长上限（秒），未达到目标进度时最多观看规划时长+15分钟 */
  private readonly maxWatchSeconds: number

  set status(s: ModuleStatusTypes) {
    useModuleStore().moduleStatus.DailyTasks.LiveTasks.medalTasks.watch = s
  }

  /** 单次运行中当前直播间已观看的时间（秒），达到时长上限即停止 */
  private watchedSeconds = 0

  private readonly areaID: number
  private readonly parentID: number
  private readonly roomID: number
  /** 主播的 UID */
  private readonly ruid: number
  private readonly uname: string
  private seq = 0
  private progress = -1
  /** 计算签名和发送请求时均需要 JSON.stringify */
  private get id(): number[] {
    return [this.parentID, this.areaID, this.seq, this.roomID]
  }

  /** Cookie LIVE_BUVID */
  private buvid?: string = useBiliStore().cookies!.LIVE_BUVID

  private uuid = uuid()

  /** 计算签名和发送请求时均需要 JSON.stringify */
  private device: string[] = [this.buvid as string, this.uuid]
  /** 浏览器 user agent */
  private ua = navigator.userAgent

  private heartBeatInterval!: number
  private secretKey!: string
  private secretRule!: number[]
  /** ets */
  private timestamp!: number

  /**
   * 开始心跳
   */
  public start(): Promise<void> {
    if (!this.buvid) {
      this.logger.error(`缺少buvid，无法为直播间 ${this.roomID} 执行观看直播任务，请尝试刷新页面`)
      return Promise.resolve()
    }
    return this.E()
  }

  /**
   * E心跳，开始时发送一次
   */
  private async E(): Promise<void> {
    try {
      const response = await BAPI.liveTrace.E(this.id, this.device, this.ruid)
      this.logger.debug(
        `BAPI.liveTrace.E(${this.id}, ${this.device}, ${this.ruid}) response`,
        response,
      )
      if (response.code === 0) {
        this.seq += 1
          ; ({
            heartbeat_interval: this.heartBeatInterval,
            secret_key: this.secretKey,
            secret_rule: this.secretRule,
            timestamp: this.timestamp,
          } = response.data)
        await sleep(this.heartBeatInterval * 1000)
        return this.X()
      } else {
        this.logger.error(
          `BAPI.liveTrace.E(${this.id}, ${this.device}, ${this.ruid}) 失败`,
          response.message,
        )
      }
    } catch (error) {
      this.logger.error(`BAPI.liveTrace.E(${this.id}, ${this.device}, ${this.ruid}) 出错`, error)
    }
  }

  /**
   * X心跳，E心跳过后都是X心跳
   */
  private async X(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.log(`观看直播开关已关闭，停止直播间 ${this.roomID} 的X心跳`)
      return
    }
    if (isNowIn(23, 59, 0, 5)) {
      this.logger.log(`即将或刚刚发生跨天，停止直播间 ${this.roomID} 的X心跳`)
      return
    }

    try {
      const spyderData: SpyderData = {
        id: JSON.stringify(this.id),
        device: JSON.stringify(this.device),
        ets: this.timestamp,
        benchmark: this.secretKey,
        time: this.heartBeatInterval,
        ts: tsm(),
        ua: this.ua,
      }
      // 签名
      const s = this.spyder(JSON.stringify(spyderData), this.secretRule)

      const response = await BAPI.liveTrace.X(
        s,
        this.id,
        this.device,
        this.ruid,
        this.timestamp,
        this.secretKey,
        this.heartBeatInterval,
        spyderData.ts,
      )
      this.logger.debug(
        `BAPI.liveTrace.X(${s}, ${this.id}, ${this.device}, ${this.ruid}, ${this.timestamp}, ${this.secretKey}, ${this.heartBeatInterval}, ${spyderData.ts}) response`,
        response,
      )
      if (response.code === 0) {
        this.seq += 1
        this.watchedSeconds += this.heartBeatInterval
        const [prog, total] = await MedalModule.getMissionProgress(this.ruid, "观看")
        if (total <= 0) {
          this.logger.log(`${this.uname}(${this.roomID}) 获取不到观看直播进度，结束观看`)
          return
        }
        if (prog != this.progress) {
          this.progress = prog;
          this.logger.log(`${this.uname}(${this.roomID}) 观看直播进度: ${prog}/${total}`)
        }
        const gained = prog - this.initialProgress
        if (gained >= this.targetProgress || prog >= total) {
          this.logger.log(
            `${this.uname}(${this.roomID}) 本次观看进度已达标(新增 ${gained}, 当前 ${prog}/${total}, 目标 ${this.targetProgress})，观看结束`,
          )
          return
        }
        if (this.watchedSeconds >= this.maxWatchSeconds) {
          return
        }
        ; ({
          heartbeat_interval: this.heartBeatInterval,
          secret_key: this.secretKey,
          secret_rule: this.secretRule,
          timestamp: this.timestamp,
        } = response.data)
        await sleep(this.heartBeatInterval * 1000)
        return this.X()
      } else {
        this.logger.error(
          `BAPI.liveTrace.X(${s}, ${this.id}, ${this.device}, ${this.ruid}, ${this.timestamp}, ${this.secretKey}, ${this.heartBeatInterval}) 失败`,
          response.message,
        )
      }
    } catch (error) {
      this.logger.error(
        `BAPI.liveTrace.X(s, ${this.id}, ${this.device}, ${this.ruid}, ${this.timestamp}, ${this.secretKey}, ${this.heartBeatInterval}) 出错`,
        error,
      )
    }
  }

  /**
   * wasm 导出的 spyder 函数的 javascript 实现
   * @param str 一个经过 JSON.stringify 的 json 字符串
   * @param rule secret_rule 数组
   * @returns s
   */
  private spyder(str: string, rule: number[]): string {
    const data: SpyderData = JSON.parse(str)
    const [parent_id, area_id, seq_id, room_id]: number[] = JSON.parse(data.id)
    const [buvid, uuid]: string[] = JSON.parse(data.device)
    const key: string = data.benchmark
    const newData = {
      platform: 'web',
      parent_id,
      area_id,
      seq_id,
      room_id,
      buvid,
      uuid,
      ets: data.ets,
      time: data.time,
      ts: data.ts,
    }
    let s = JSON.stringify(newData)
    for (const r of rule) {
      switch (r) {
        case 0:
          s = CryptoJS.HmacMD5(s, key).toString(CryptoJS.enc.Hex)
          break
        case 1:
          s = CryptoJS.HmacSHA1(s, key).toString(CryptoJS.enc.Hex)
          break
        case 2:
          s = CryptoJS.HmacSHA256(s, key).toString(CryptoJS.enc.Hex)
          break
        case 3:
          s = CryptoJS.HmacSHA224(s, key).toString(CryptoJS.enc.Hex)
          break
        case 4:
          s = CryptoJS.HmacSHA512(s, key).toString(CryptoJS.enc.Hex)
          break
        case 5:
          s = CryptoJS.HmacSHA384(s, key).toString(CryptoJS.enc.Hex)
          break
        default:
          s = CryptoJS.HmacMD5(s, key).toString(CryptoJS.enc.Hex)
      }
    }
    return s
  }
}

class WatchTask extends MedalModule {
  static runAt: RunAtMoment = 'window-load'

  config = this.medalTasksConfig.watch

  set status(s: ModuleStatusTypes) {
    useModuleStore().moduleStatus.DailyTasks.LiveTasks.medalTasks.watch = s
  }

  private playerStore = usePlayerStore()

  /**
   * 获取粉丝勋章
   * @returns 根据直播状态划分、经过排序和过滤的粉丝勋章
   */
  private getMedals(): LiveData.FansMedalPanel.List[] {
    const fansMedals = useBiliStore().filteredFansMedals;
    const result = fansMedals.filter(
      (medal) =>
        medal.medal.is_lighted
        && (
          this.PUBLIC_MEDAL_FILTERS.whiteBlackList(medal)
          && (this.medalTasksConfig.roomidList2.some((entry) => entry.roomid === medal.room_info.room_id)
            || medal.medal.level < 15)
        )
    );
    result.sort(this.sort_live_medals);
    this.logger.log(`观看直播列表(${result.length}): ${result.map(medal => medal.anchor_info.nick_name)} `)
    return result;
  }

  /**
   * 获取指定直播间的 area_id 和 parent_area_id
   *
   * 出错时返回 [-1, -1]
   *
   * @param roomid 房间号
   * @returns [area_id, parent_area_id]
   */
  private async getAreaInfo(url: string, roomid: number): Promise<[number, number]> {
    try {
      // 先尝试从 url 中提取 area_id 和 parent_area_id
      const urlObj = new URL(url)
      const area_id = Number(urlObj.searchParams.get('area_id'))
      const parent_area_id = Number(urlObj.searchParams.get('parent_area_id'))

      if (area_id > 0 && parent_area_id > 0) {
        this.logger.log(
          `已从直播间链接中（roomid = ${roomid}）获取到分区数据（area_id = ${area_id}，parent_area_id = ${parent_area_id}）`,
          urlObj,
        )
        return [area_id, parent_area_id]
      }

      // 如果无法从 url 中提取到分区数据，调用 API 获取
      const response = await BAPI.live.getInfoByRoom(roomid)
      this.logger.log(`BAPI.live.getInfoByRoom(${roomid}) response`, response)

      if (response.code === 0) {
        const room_info = response.data.room_info
        return [room_info.area_id, room_info.parent_area_id]
      } else {
        return [-1, -1]
      }
    } catch (error) {
      this.logger.error(
        `获取指定直播间的 area_id 和 parent_area_id(roomid = ${roomid}) 出错`,
        error,
      )
      return [-1, -1]
    }
  }

  public async run(): Promise<void> {
    this.logger.log('观看直播模块开始运行')

    if (!(await this.waitForFansMedals())) {
      this.logger.error('粉丝勋章数据不存在，不执行观看直播任务')
      this.status = 'error'
      return
    }

    this.status = 'running'

    const fansMedals = this.getMedals()
    let _len = fansMedals.length
    if (_len > 0) {
      let i: number

      for (i = 0; i < fansMedals.length; i++) {
        if (!this.config.enabled) {
          this.logger.log('观看直播开关已关闭，停止观看直播任务')
          break
        }
        if (isNowIn(23, 55, 0, 5)) {
          this.logger.log('即将或刚刚发生跨天，提早结束本轮观看直播任务')
          break
        }

        const medal = fansMedals[i]
        const roomid = medal.room_info.room_id
        const uid = medal.medal.target_id
        const uname = medal.anchor_info.nick_name
        const [area_id, parent_area_id] = await this.getAreaInfo(medal.room_info.url, roomid)
        let watchMinutes = this.config.time
        if (this.config.autoAllocateTime) {
          // 把到 24:00 之前的剩余时间平均分配给剩余的直播间（_len 为含当前直播间在内的剩余数量），
          // 单个直播间仍不超过配置时长
          watchMinutes = Math.min(watchMinutes, delayToNextMoment(0, 0).ms / (1000 * 60 * _len))
        }
        // 向上取整到15的倍数
        watchMinutes = Math.ceil(watchMinutes / 15) * 15
        if (area_id > 0 && parent_area_id > 0) {
          const [prog, total] = await MedalModule.getMissionProgress(uid, "观看")
          const targetProgress = watchMinutes / 15
          if (total <= 0) {
            this.logger.log(`${uname}(${roomid}) 获取不到观看直播进度，跳过该直播间`)
            continue
          }
          if (prog >= total) {
            this.logger.log(`${uname}(${roomid}) 观看直播进度已满，${prog}/${total}`)
            continue
          }
          // area_id 和 parent_area_id 都大于 0，说明直播间设置了分区，心跳有效
          this.logger.log(
            `粉丝勋章【${medal.medal.medal_name}】 开始直播间 ${roomid}（主播【${uname}】，UID：${uid}）的观看直播任务，本次目标进度: +${targetProgress}，当前进度: ${prog}/${total}，设定观看时间: ${watchMinutes}分钟`,
          )

          await new RoomHeart(
            roomid,
            uname,
            area_id,
            parent_area_id,
            uid,
            watchMinutes,
            prog
          ).start()
        }
        _len--
      }

      if (i === fansMedals.length) {
        // 没有提早跳出循环，说明所有直播间的观看任务均已完成
        this.config._lastCompleteTime = tsm()
        this.logger.log('观看直播任务已完成')
        this.status = 'done'
      } else {
        this.status = ''
      }
    } else {
      this.status = 'done'
      this.config._lastCompleteTime = tsm()
    }

    const diff = delayToNextMoment()
    this.nextRunTimer = setTimeout(() => this.run(), diff.ms)
    this.logger.log('距离观看直播模块下次运行时间:', diff.str)
  }
}

export default WatchTask
