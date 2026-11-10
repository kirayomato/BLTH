// 环境适配必须先于一切：共享源码在导入阶段就会访问 document / window
import './polyfill'

import { existsSync } from 'node:fs'
import { createPinia, setActivePinia } from 'pinia'
import Logger from '@/library/logger'
import defaultValues from '@/library/storage/defaultValues'
import type BaseModule from '@/modules/BaseModule'
import * as defaultModules from '@/modules/default'
import * as dailyModules from '@/modules/dailyTasks'
import { useBiliStore, useModuleStore } from '@/stores'
import { options } from './config'
import { startControlChannel } from './control'
import { getCriticalError, loadModule, runModule, startModules, type ModulePlan } from './runner'
import { storage } from './storage'

const logger = new Logger('Standalone')

/** 默认模块：为任务提供数据，数组顺序即依赖顺序 */
const DEFAULT_MODULE_NAMES = [
  'Default_Cookies',
  'Default_UserInfo',
  'Default_DailyRewardInfo',
  'Default_DynamicVideos',
  'Default_FansMedals',
]

/** 任务模块：全部为纯接口调用，彼此独立 */
const TASK_MODULE_NAMES = [
  'DailyTask_MainSiteTask_LoginTask',
  'DailyTask_MainSiteTask_WatchTask',
  'DailyTask_MainSiteTask_CoinTask',
  'DailyTask_MainSiteTask_ShareTask',
  'DailyTask_LiveTask_LightTask',
  'DailyTask_LiveTask_WatchTask',
  'DailyTask_OtherTask_SilverToCoinTask',
  'DailyTask_OtherTask_CoinToSilverTask',
  'DailyTask_OtherTask_GetYearVipPrivilegeTask',
]

const moduleMap = {
  ...defaultModules,
  ...dailyModules,
} as Record<string, typeof BaseModule>

const modulePlan: ModulePlan = {
  moduleMap,
  defaultNames: DEFAULT_MODULE_NAMES,
  taskNames: TASK_MODULE_NAMES,
}

/**
 * 首次运行时写出配置模板，让可配置项一目了然。
 */
function seedStorage(): void {
  if (existsSync(storage.path)) {
    return
  }

  // 独立运行版只跑每日任务，不写出页面增强相关的配置
  storage.set('modules', { DailyTasks: defaultValues.modules.DailyTasks })

  logger.log(`已生成配置文件：${storage.path}`)
  logger.log('其中所有任务默认关闭，请按需将 enabled 改为 true')
}

async function bootstrap(): Promise<void> {
  logger.log(`数据目录：${options.dataDir}`)
  logger.log(`cookie 文件：${options.cookieFile}`)

  seedStorage()

  // 触发 store 初始化：读取配置文件，并注册配置变更后的写盘逻辑
  useModuleStore()
  logger.log(`模块配置：${storage.path}`)

  // 控制通道要在默认模块加载前就绪：那一阶段可能有较慢的接口请求，页面不应跟着卡住
  startControlChannel()

  await startModules(modulePlan)

  logger.log('启动完成，进程将常驻运行，按 Ctrl+C 退出')
}

function shutdown(signal: string): void {
  logger.log(`收到 ${signal}，正在保存状态`)
  // 配置写入带短防抖，留出时间让最后一次变更落盘
  setTimeout(() => process.exit(0), 600)
}

/**
 * 探针模式：只发一次用户信息请求，用于检查 cookie 与请求链路。
 */
async function probe(): Promise<void> {
  logger.log('探针模式：仅执行一次用户信息请求')

  const instance = loadModule(moduleMap.Default_UserInfo, 'Default_UserInfo')
  if (!instance) {
    logger.error('无法加载 Default_UserInfo 模块')
    process.exit(1)
  }

  await runModule('Default_UserInfo', instance)

  const userInfo = useBiliStore().userInfo
  if (userInfo?.isLogin) {
    logger.log(`登录状态正常：${userInfo.uname}（UID ${userInfo.mid}）`)
  } else {
    logger.error('未取得有效登录信息，请检查 cookie 是否有效')
  }

  process.exit(getCriticalError() ? 1 : 0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
// Windows 下控制台发来 Ctrl+Break 时走同一套退出流程
process.on('SIGBREAK', () => shutdown('SIGBREAK'))

setActivePinia(createPinia())

// 没有内嵌服务器后需要一个常驻 handle：任务全部关闭时不会有任何排期定时器
setInterval(() => undefined, 60_000)

const entry = process.env.BLTH_PROBE === '1' ? probe : bootstrap

entry().catch((error: Error) => {
  logger.error(`启动失败：${error.message}`)
  process.exit(1)
})
