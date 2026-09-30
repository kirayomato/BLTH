import type BaseModule from '@/modules/BaseModule'
import { delayToNextMoment } from '@/library/luxon'
import Logger from '@/library/logger'
import ModuleCriticalError from '@/library/error/ModuleCriticalError'
import { useModuleStore } from '@/stores'
import { options } from './config'

const logger = new Logger('Standalone')

/** 正在执行的模块，避免看门狗与进行中的任务重叠触发 */
const running = new Set<string>()

/**
 * 纳入自动调度的任务模块
 *
 * 只有登记过的模块才有兜底排期与看门狗保护。默认模块是一次性的数据加载，其中未自行排期的
 * （如 Default_Cookies）本就没有周期性运行的需求，登记进来只会被反复触发。
 */
const taskModuleNames = new Set<string>()

let criticalError: Error | undefined

/**
 * 登记需要兜底调度与看门狗保护的任务模块。需在任务模块首次运行之前调用。
 */
export function registerTaskModules(names: string[]): void {
  for (const name of names) {
    taskModuleNames.add(name)
  }
}

/**
 * 实例化模块并登记到 moduleInstances。
 *
 * 登记这一步是必须的：模块之间会相互触发（例如勋章任务内部会调用
 * `rerunModule('Default_FansMedals')`），缺少登记会让那次调用抛出异常。
 *
 * @returns 已启用的模块实例，未启用时返回 undefined
 */
export function loadModule(module: typeof BaseModule, name: string): BaseModule | undefined {
  const moduleStore = useModuleStore()
  const instance = new module(name)
  moduleStore.moduleInstances[name] = instance

  return instance.isEnabled() ? instance : undefined
}

/**
 * 运行模块。失败只记录日志，不向外抛出，以免中断其余模块的调度。
 */
export async function runModule(name: string, instance: BaseModule): Promise<void> {
  if (running.has(name)) {
    return
  }

  running.add(name)
  try {
    await instance.run()
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    logger.error(`模块 ${name} 运行出错：${failure.message}`)

    if (error instanceof ModuleCriticalError) {
      criticalError = failure
    }
  } finally {
    running.delete(name)
    scheduleFallback(name, instance)
  }
}

/**
 * 兜底排期。
 *
 * 任务模块正常的结束方式是自行安排下次运行，但异常路径可能直接返回而漏掉这一步；常驻进程里
 * 没有刷新页面可以依赖，缺了调度该模块就永久停摆。这里补一个次日零点的检查——对于「本轮结束
 * 后长期不需要再运行」的正常分支（例如距离下次领取超过一天的大会员权益），它同时充当每日自检。
 */
function scheduleFallback(name: string, instance: BaseModule): void {
  if (!taskModuleNames.has(name) || instance.nextRunTimer) {
    return
  }

  const diff = delayToNextMoment()
  logger.log(`模块 ${name} 本轮未安排下次运行，将于 ${diff.str} 后重新运行`)

  instance.nextRunTimer = setTimeout(() => {
    // 定时器已触发，先清空再进入下一轮，否则看门狗会认为该模块仍处于排期状态
    instance.nextRunTimer = undefined
    void runModule(name, instance)
  }, diff.ms)
}

export function getCriticalError(): Error | undefined {
  return criticalError
}

/**
 * 失效看门狗。
 *
 * 任务模块在异常路径上会直接返回而不安排下次运行——这个行为在原环境下靠刷新页面兜底，
 * 常驻进程里没有刷新机会，于是一次瞬时故障就会让该任务永久停摆。这里定期把这类模块重新拉起。
 *
 * 只监视登记过的任务模块，且只兜底「本该有下次运行却没有」的情况；正常结束且不排期的模块
 * 已由 scheduleFallback 接走，不会落到这里。
 */
export function startWatchdog(): void {
  const timer = setInterval(() => {
    const moduleStore = useModuleStore()

    for (const name of taskModuleNames) {
      const instance = moduleStore.moduleInstances[name]
      if (!instance || !instance.isEnabled() || instance.nextRunTimer || running.has(name)) {
        continue
      }

      logger.warn(`模块 ${name} 未安排下次运行，重新触发`)
      void runModule(name, instance)
    }
  }, options.watchdogInterval)

  // 看门狗本身不应阻止进程退出
  ;(timer as any).unref?.()
}
