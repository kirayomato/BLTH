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
  nick_name: string
  medal_name: string
  avatar: string
  /** 粉丝勋章等级 */
  medal_level: number
  /** 粉丝勋章是否已点亮 */
  is_lighted: boolean
  /** 「点赞30次」任务当前进度；未点亮或查询失败时为 null */
  likeProgress: number | null
  /** 「点赞30次」任务进度上限；未点亮或查询失败时为 null */
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

export {
  PublicMedalFilters,
  LightTaskMedalFilters,
  MedalsByLivingStatus,
  LiveStatusSnapshot,
  RequestQueueKey,
  LikeRoomCandidate,
  LikeCandidateSnapshot,
}
