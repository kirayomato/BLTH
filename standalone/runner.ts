import type BaseModule from '@/modules/BaseModule'
import Logger from '@/library/logger'
import ModuleCriticalError from '@/library/error/ModuleCriticalError'
import { useModuleStore } from '@/stores'
import { options } from './config'

const logger = new Logger('Standalone')

/** 正在执行的模块，避免看门狗与进行中的任务重叠触发 */
const running = new Set<string>()

let criticalError: Error | undefined

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
  }
}

export function getCriticalError(): Error | undefined {
  return criticalError
}

/**
 * 失效看门狗。
 *
 * 任务模块在异常路径上会直接返回而不安排下次运行——这个行为在原环境下靠刷新页面兜底，
 * 常驻进程里没有刷新机会，于是一次瞬时故障就会让该任务永久停摆。这里定期把这类模块重新拉起。
 */
export function startWatchdog(): void {
  const timer = setInterval(() => {
    const moduleStore = useModuleStore()

    for (const [name, instance] of Object.entries(moduleStore.moduleInstances)) {
      if (!instance.isEnabled() || instance.nextRunTimer || running.has(name)) {
        continue
      }

      logger.warn(`模块 ${name} 未安排下次运行，重新触发`)
      void runModule(name, instance)
    }
  }, options.watchdogInterval)

  // 看门狗本身不应阻止进程退出
  ;(timer as any).unref?.()
}
