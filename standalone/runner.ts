import { toRaw } from 'vue'
import type BaseModule from '@/modules/BaseModule'
import { delayToNextMoment } from '@/library/luxon'
import Logger from '@/library/logger'
import ModuleCriticalError from '@/library/error/ModuleCriticalError'
import { useModuleStore } from '@/stores'
import { options } from './config'

const logger = new Logger('Standalone')

/**
 * 正在执行的模块与它当前占用的实例。
 *
 * 按实例身份记「当前占用者」：同一实例不允许重入，
 * 同名的新实例是另一个对象，不受旧实例占用影响。
 */
const running = new Map<string, BaseModule>()

/**
 * 纳入自动调度的任务模块
 *
 * 只有登记过的模块才有兜底排期与看门狗保护。默认模块是一次性的数据加载，其中未自行排期的
 * （如 Default_Cookies）本就没有周期性运行的需求，登记进来只会被反复触发。
 */
const taskModuleNames = new Set<string>()

let criticalError: Error | undefined

let watchdogTimer: ReturnType<typeof setInterval> | undefined

/** 启动所需的模块清单，由入口传入 */
export interface ModulePlan {
  /** 模块名到模块类的映射 */
  moduleMap: Record<string, typeof BaseModule>
  /** 默认模块，数组顺序即依赖顺序 */
  defaultNames: string[]
  /** 任务模块 */
  taskNames: string[]
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
  // moduleInstances 取出来的是响应式代理，统一按原始对象记账与比对
  const target = toRaw(instance)

  if (running.get(name) === target) {
    return
  }

  running.set(name, target)

  try {
    await target.run()
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    logger.error(`模块 ${name} 运行出错：${failure.message}`)

    if (error instanceof ModuleCriticalError && isCurrent(name, target)) {
      criticalError = failure
    }
  } finally {
    if (running.get(name) === target) {
      running.delete(name)
    }

    if (isCurrent(name, target)) {
      scheduleFallback(name, target)
    }
  }
}

/** 该实例是否仍是 store 里登记的那一个 */
function isCurrent(name: string, instance: BaseModule): boolean {
  return toRaw(useModuleStore().moduleInstances[name]) === instance
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
  // 重复调用时先撤掉旧的，避免多个看门狗同时触发同一模块
  stopWatchdog()

  watchdogTimer = setInterval(() => {
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
  ;(watchdogTimer as any).unref?.()
}

function stopWatchdog(): void {
  if (watchdogTimer !== undefined) {
    clearInterval(watchdogTimer)
    watchdogTimer = undefined
  }
}

/**
 * 按启动流程跑一遍模块：默认模块串行完成后，任务模块并行启动。
 */
export async function startModules(plan: ModulePlan): Promise<void> {
  for (const name of plan.taskNames) {
    taskModuleNames.add(name)
  }

  try {
    for (const name of plan.defaultNames) {
      const module = plan.moduleMap[name]
      if (!module) {
        logger.error(`未找到默认模块 ${name}`)
        continue
      }

      const instance = loadModule(module, name)
      if (instance) {
        await runModule(name, instance)
      }
    }

    const failure = getCriticalError()
    const started: string[] = []

    if (failure) {
      // 不直接退出：cookie 失效一类的问题下，控制台里的运行日志是排查所需的入口
      logger.warn(`默认模块发生致命错误，本次不启动任务：${failure.message}`)
    } else {
      for (const name of plan.taskNames) {
        const module = plan.moduleMap[name]
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

      if (started.length > 0) {
        logger.log(`已启用 ${started.length} 项任务：${started.join('、')}`)
      } else {
        logger.warn('没有启用任何任务，可在配置页面中开启')
      }
    }
  } finally {
    // 中途出错也必须留下看门狗，否则常驻进程会失去唯一的兜底调度
    startWatchdog()
  }
}
