import { LiveData, LiveTraceData, MainData } from './data'

declare namespace Live {
  interface FansMedalPanel {
    code: number
    message: string
    ttl: number
    data: LiveData.FansMedalPanel.Data
  }

  interface SendMsg {
    code: number
    data: LiveData.SendMsg.Data
    message: string
    msg: string
  }

  interface LikeReport {
    code: number
    message: string
    ttl: number
    data: {}
  }

  interface GetInfoByRoom {
    code: number
    message: string
    ttl: number
    data: LiveData.GetInfoByRoom.Data
  }

  interface Silver2coin {
    code: number
    data: LiveData.Silver2coin.Data
    message: string
  }

  interface Coin2silver {
    code: number
    data: { silver: number }
    message: string
  }

  interface GetActivatedMedalInfo {
    code: number
    message: string
    ttl: number
    data: {
      face: string
      name: string
      medal_name: string
      fans_medal_count: number
      level: number
      is_lighted: boolean
      intimacy: number
      next_intimacy: number
      task_light_days: number
      task_info: TaskInfo[]
      fans_club_gift_info: FansClubGiftInfo
      medal_color_border: string
      medal_color: string
      medal_color_text: string
      medal_color_level: string
      guard_level: number
      light_source: number
      free_intimacy: number
      reach_free_intimacy_limit: boolean
    }
  }
}

declare namespace LiveTrace {
  interface E {
    code: number
    message: string
    ttl: number
    data: LiveTraceData.E.Data
  }

  interface X {
    code: number
    message: string
    ttl: number
    data: LiveTraceData.X.Data
  }
}

declare namespace Main {
  interface Nav {
    code: number
    message: string
    ttl: number
    data: MainData.Nav.Data
  }

  interface Reward {
    code: number
    message: string
    ttl: number
    data: MainData.Reward.Data
  }

  interface DynamicAll {
    code: number
    message: string
    ttl: number
    data: MainData.DynamicAll.Data
  }

  interface VideoHeartbeat {
    code: number
    message: string
    ttl: number
  }

  interface Share {
    code: number
    message: string
    data: number
    ttl: number
  }

  interface CoinAdd {
    code: number
    message: string
    ttl: number
    data: { like: boolean }
  }

  interface VideoRelation {
    code: number
    message: string
    ttl: number
    data: MainData.VideoRelation.Data
  }

  namespace Vip {
    interface MyPrivilege {
      code: number
      message: string
      ttl: number
      data: MainData.Vip.MyPrivilege.Data
    }

    interface ReceivePrivilege {
      code: number
      message: string
      ttl: number
      data: MainData.Vip.ReceivePrivilege.Data
    }

    interface AddExperience {
      code: number
      message: string
      ttl: number
      data: MainData.Vip.AddExperience.Data
    }
  }
}

export { Live, LiveTrace, Main }
