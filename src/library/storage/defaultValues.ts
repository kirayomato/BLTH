import type { UiConfig, ModuleConfig, Cache } from '@/types'

interface DefaultValues {
  ui: UiConfig
  modules: ModuleConfig
  cache: Cache
}

const defaultValues: DefaultValues = {
  ui: {
    isCollapse: false,
    isShowPanel: true,
    activeMenuIndex: 'MainSiteTasks',
    panelWidthPercent: 45,
    medalInfoPanelSortMode: false,
  },
  modules: {
    DailyTasks: {
      MainSiteTasks: {
        login: {
          enabled: false,
          _lastCompleteTime: 0,
        },
        watch: {
          enabled: false,
          _lastCompleteTime: 0,
        },
        coin: {
          enabled: false,
          num: 1,
          _lastCompleteTime: 0,
        },
        share: {
          enabled: false,
          _lastCompleteTime: 0,
        },
      },
      LiveTasks: {
        medalTasks: {
          light: {
            enabled: false,
            danmuList: [
              '(⌒▽⌒)',
              '（￣▽￣）',
              '(=・ω・=)',
              '(｀・ω・´)',
              '(〜￣△￣)〜',
              '(･∀･)',
              '(°∀°)ﾉ',
              '╮(￣▽￣)╭',
              '_(:3」∠)_',
              '(^・ω・^ )',
              '(●￣(ｴ)￣●)',
              'ε=ε=(ノ≧∇≦)ノ',
              '⁄(⁄ ⁄•⁄ω⁄•⁄ ⁄)⁄',
              '←◡←',
              `(●'◡'●)ﾉ♥`,
            ],
            emojiList: [
              "official_331",
              "official_332",
              "official_348",
              "official_343",
              "official_335",
              "official_345",
              "official_339",
              "official_337",
              "official_342",
              "official_346",
              "official_147",
              "official_109",
              "official_113",
              "official_150",
              "official_103",
              "official_128",
              "official_133",
              "official_149",
              "official_124",
              "official_146",
              "official_148",
              "official_102",
              "official_137",
              "official_118",
              "official_108",
              "official_104",
              "official_105",
              "official_106",
              "official_110",
              "official_111",
              "official_115",
              "official_116",
              "official_117",
              "official_119",
              "official_122",
              "official_125",
              "official_126",
              "official_134"
            ],
            _lastCompleteTime: 0,
          },
          watch: {
            enabled: false,
            time: 25,
            _watchingProgress: {},
            _lastWatchTime: 0,
            _lastCompleteTime: 0,
          },
          isWhiteList: false,
          roomidList: [],
          roomidList2: []
        },
      },
      OtherTasks: {
        silverToCoin: {
          enabled: false,
          _lastCompleteTime: 0,
        },
        coinToSilver: {
          enabled: false,
          num: 1,
          _lastCompleteTime: 0,
        },
        getYearVipPrivilege: {
          enabled: false,
          _nextReceiveTime: 0,
        },
      },
    },
    EnhanceExperience: {
      switchLiveStreamQuality: {
        enabled: false,
        qualityDesc: '原画',
      },
      banp2p: {
        enabled: false,
      },
      noReport: {
        enabled: false,
      },
      noSleep: {
        enabled: false,
      },
      invisibility: {
        enabled: false,
      },
      autoRestart: {
        enabled: false,
        intervalMinutes: 60,
      },
    },
    RemoveElement: {
      removePKBox: {
        enabled: false,
      },
      removeLiveWaterMark: {
        enabled: false,
      },
      removeShopPopover: {
        enabled: false,
      },
      removeGameParty: {
        enabled: false,
      },
      removeGiftPopover: {
        enabled: false,
      },
      removeMicPopover: {
        enabled: false,
      },
      removeComboCard: {
        enabled: false,
      },
      removeHeaderStuff: {
        enabled: false,
      },
      removeFlipView: {
        enabled: false,
      },
      removeLiveMosaic: {
        enabled: false,
      },
    },
  },
  cache: {
    lastAliveHeartBeatTime: 0,
    mainScriptLocation: '',
  },
}

export default defaultValues
