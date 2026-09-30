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
import {
  getCriticalError,
  loadModule,
  registerTaskModules,
  runModule,
  startWatchdog,
} from './runner'
import { startConfigServer } from './server'
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

/**
 * 首次运行时写出配置模板，让可配置项一目了然。
 */
function seedStorage(): void {
  if (existsSync(storage.path)) {
    return
  }

  // 独立运行版没有控制面板与页面增强功能，只写出任务相关的配置
  storage.set('modules', { DailyTasks: defaultValues.modules.DailyTasks })

  logger.log(`已生成配置文件：${storage.path}`)
  logger.log('其中所有任务默认关闭，请按需将 enabled 改为 true')
}

async function bootstrap(): Promise<void> {
  logger.log(`数据目录：${options.dataDir}`)
  logger.log(`cookie 文件：${options.cookieFile}`)

  seedStorage()

  // 配置服务尽早启动：默认模块的数据请求可能耗时较久，不该拖慢页面的可用时间
  startConfigServer()

  // 触发 store 初始化：读取配置文件，并注册配置变更后的写盘逻辑
  useModuleStore()
  logger.log(`模块配置：${storage.path}`)

  // 登记需要兜底调度与看门狗保护的任务模块
  registerTaskModules(TASK_MODULE_NAMES)

  // 默认模块按序完成首次运行，任务模块依赖它们产出的数据
  for (const name of DEFAULT_MODULE_NAMES) {
    const module = moduleMap[name]
    if (!module) {
      logger.error(`未找到默认模块 ${name}`)
      continue
    }

    const instance = loadModule(module, name)
    if (instance) {
      await runModule(name, instance)
    }
  }

  const criticalError = getCriticalError()
  if (criticalError) {
    // 不直接退出：cookie 失效一类的问题下，配置页面恰好是排查所需的入口
    logger.warn(`默认模块发生致命错误，本次不启动任务：${criticalError.message}`)
  }

  // 任务模块并行启动，各自在内部安排后续运行
  const started: string[] = []
  if (!criticalError) {
    for (const name of TASK_MODULE_NAMES) {
      const module = moduleMap[name]
      if (!module) {
        logger.error(`未找到任务模块 ${name}`)
        continue
      }

      const instance = loadModule(module, name)
      if (instance) {
        void runModule(name, instance)
        started.push(name)
      }
    }
  }

  if (started.length === 0 && !criticalError) {
    logger.warn('没有启用任何任务，可在配置页面中开启')
  } else if (started.length > 0) {
    logger.log(`已启用 ${started.length} 项任务：${started.join('、')}`)
  }

  startWatchdog()
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

setActivePinia(createPinia())

const entry = process.env.BLTH_PROBE === '1' ? probe : bootstrap

entry().catch((error: Error) => {
  logger.error(`启动失败：${error.message}`)
  process.exit(1)
})
