import type { LiveData } from '@/library/bili-api/data'

type LiveStatus = 'on' | 'off'

interface LiveStatusSnapshot {
  liveStatus: number
  observedAt: number
}

type RequestQueueKey = 'taskInfo' | 'roomStatus'

interface PublicMedalFilters {
  whiteBlackList: (medal: LiveData.FansMedalPanel.List) => boolean
  levelLt120: (medal: LiveData.FansMedalPanel.List) => boolean
}

interface LightTaskMedalFilters {
  isLighted: (medal: LiveData.FansMedalPanel.List) => boolean
  livingStatus: (medal: LiveData.FansMedalPanel.List) => LiveStatus
}

type MedalsByLivingStatus = Record<LiveStatus, LiveData.FansMedalPanel.List[]>

/** 手动点赞时可选择的直播间 */
interface LikeRoomCandidate {
  roomid: number
  /** 主播 UID */
  uid: number
  nick_name: string
  medal_name: string
  avatar: string
  /** 粉丝勋章等级 */
  medal_level: number
  /** 粉丝勋章是否已点亮 */
  is_lighted: boolean
  /** 亲密度储蓄值（上限 100）；信息不可用时为 null */
  freeIntimacy: number | null
  /** 亲密度储蓄是否已满（满了点赞不再增加亲密度） */
  reachFreeIntimacyLimit: boolean
  /** 「点赞30次」任务当前进度；未点亮时为 null（任务信息不可用的直播间不会进候选） */
  likeProgress: number | null
  /** 「点赞30次」任务进度上限；未点亮时为 null（任务信息不可用的直播间不会进候选） */
  likeProgressTotal: number | null
}

/** 手动点赞的候选快照：候选列表 + 今日点赞额度信息 */
interface LikeCandidateSnapshot {
  /** 可点赞的直播间列表 */
  candidates: LikeRoomCandidate[]
  /** 今日已点赞总次数 */
  todayLikes: number
  /** 每日点赞上限 */
  dailyLimit: number
}

/**
 * `GetActivatedMedalInfo` 的摘要信息
 *
 * 粉丝勋章面板（fansMedals）是启动时的快照，点亮状态会随实时交互变化：
 * 未点亮 → 已点亮后开始受每日上限约束，已点亮 → 熄灭后需要重新点亮。
 * 该接口一次请求同时给出点亮状态与任务列表，用于刷新快照并按最新状态分支。
 */
interface ActivatedMedalSummary {
  /** 是否已点亮 */
  isLighted: boolean
  /** 亲密度储蓄值（上限 100） */
  freeIntimacy: number
  /** 亲密度储蓄是否已满（满了无法继续做任务） */
  reachFreeIntimacyLimit: boolean
  /** 任务列表；接口未返回时为空数组 */
  tasks: LiveData.TaskItem[]
}

/**
 * 一次 `GetActivatedMedalInfo` 请求得到的任务状态
 *
 * 进度与点亮状态来自同一个响应，刷新点亮状态不需要额外请求。
 */
interface MedalMissionState {
  /** 请求是否成功 */
  available: boolean
  /** 是否已点亮（已同步回勋章快照） */
  isLighted: boolean
  /** 亲密度储蓄值；请求失败或数据缺失时为 null */
  freeIntimacy: number | null
  /** 亲密度储蓄是否已满（满了无法继续做任务） */
  reachFreeIntimacyLimit: boolean
  /** 任务当前进度 */
  prog: number
  /** 任务进度上限；0 表示任务信息不可用 */
  total: number
}

export {
  PublicMedalFilters,
  LightTaskMedalFilters,
  MedalsByLivingStatus,
  LiveStatusSnapshot,
  RequestQueueKey,
  LikeRoomCandidate,
  LikeCandidateSnapshot,
  ActivatedMedalSummary,
  MedalMissionState,
}
