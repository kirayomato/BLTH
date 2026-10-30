/** 房间名单条目：同时存储房间号和用户名 */
interface RoomidEntry {
  roomid: number
  /** 用户名，允许留空，运行时按粉丝勋章数据自动更新 */
  name: string
}

interface ModuleConfig {
  DailyTasks: {
    MainSiteTasks: {
      login: {
        enabled: boolean
        _lastCompleteTime: number
      }
      watch: {
        enabled: boolean
        _lastCompleteTime: number
      }
      coin: {
        enabled: boolean
        num: number
        _lastCompleteTime: number
      }
      share: {
        enabled: boolean
        _lastCompleteTime: number
      }
    }
    LiveTasks: {
      medalTasks: {
        light: {
          enabled: boolean
          /** 点赞功能开关 */
          likeEnabled: boolean
          /** 弹幕功能开关 */
          danmuEnabled: boolean
          danmuList: string[]
          emojiList: string[]
          _lastCompleteTime: number
          _todayLightLikes: number
          /** 今日点赞计数所属的时间戳，用于跨天重置；与 _lastCompleteTime（模块每轮运行都会更新）分开 */
          _lastLikeTime: number
        }
        watch: {
          enabled: boolean
          time: number
          _watchingProgress: Record<string, number>
          _lastWatchTime: number
          _lastCompleteTime: number
        }
        isWhiteList: boolean
        roomidList: RoomidEntry[]
        roomidList2: RoomidEntry[]
      }
    }
    OtherTasks: {
      silverToCoin: {
        enabled: boolean
        _lastCompleteTime: number
      }
      coinToSilver: {
        enabled: boolean
        num: number
        _lastCompleteTime: number
      }
      getYearVipPrivilege: {
        enabled: boolean
        _nextReceiveTime: number
      }
    }
  }
  EnhanceExperience: {
    switchLiveStreamQuality: {
      enabled: boolean
      qualityDesc: string
    }
    banp2p: {
      enabled: boolean
    }
    noReport: {
      enabled: boolean
    }
    noSleep: {
      enabled: boolean
    }
      invisibility: {
        enabled: boolean
      }
      autoRestart: {
        enabled: boolean
        intervalMinutes: number
      }
    }
  RemoveElement: {
    removePKBox: {
      enabled: boolean
    }
    removeLiveWaterMark: {
      enabled: boolean
    }
    removeShopPopover: {
      enabled: boolean
    }
    removeGameParty: {
      enabled: boolean
    }
    removeGiftPopover: {
      enabled: boolean
    }
    removeMicPopover: {
      enabled: boolean
    }
    removeComboCard: {
      enabled: boolean
    }
    removeHeaderStuff: {
      enabled: boolean
    }
    removeFlipView: {
      enabled: boolean
    }
    removeLiveMosaic: {
      enabled: boolean
    }
  }
}

type MenuIndex =
  | 'MainSiteTasks'
  | 'LiveTasks'
  | 'OtherTasks'
  | 'EnhanceExperience'
  | 'RemoveElement'
  | 'ScriptSettings'

interface UiConfig {
  isCollapse: boolean
  isShowPanel: boolean
  activeMenuIndex: MenuIndex
  panelWidthPercent: number
  medalInfoPanelSortMode: boolean
}

interface Cache {
  lastAliveHeartBeatTime: number
  mainScriptLocation: string
}

export { ModuleConfig, UiConfig, Cache, MenuIndex, RoomidEntry }
