import { toRaw } from 'vue'
import type BaseModule from '@/modules/BaseModule'
import { delayToNextMoment } from '@/library/luxon'
import Logger from '@/library/logger'
import ModuleCriticalError from '@/library/error/ModuleCriticalError'
import Storage from '@/library/storage'
import { useModuleStore } from '@/stores'
import { isLogLevel, options, setLogLevel, type LogLevel } from './config'
import { overwriteConfig } from './config-merge'
import { resetCookieCache } from './cookie'
import { storage } from './storage'

const logger = new Logger('Standalone')

/** 正在执行的模块及其所属代次，避免看门狗与进行中的任务重叠触发 */
const running = new Map<string, number>()

/**
 * 纳入自动调度的任务模块
 *
 * 只有登记过的模块才有兜底排期与看门狗保护。默认模块是一次性的数据加载，其中未自行排期的
 * （如 Default_Cookies）本就没有周期性运行的需求，登记进来只会被反复触发。
 */
const taskModuleNames = new Set<string>()

let criticalError: Error | undefined

/** 调度代次：重载后自增，上一轮的实例收尾时不再改动新一轮的调度状态 */
let generation = 0

let watchdogTimer: ReturnType<typeof setInterval> | undefined

/** 重载所需的模块清单，由入口在启动时登记 */
export interface ReloadPlan {
  /** 模块名到模块类的映射 */
  moduleMap: Record<string, typeof BaseModule>
  /** 默认模块，数组顺序即依赖顺序 */
  defaultNames: string[]
  /** 任务模块 */
  taskNames: string[]
}

let reloadPlan: ReloadPlan | undefined

/**
 * 在途任务的开关恢复函数，按模块名索引。
 *
 * 重载时临时关掉在途任务的开关让它们尽快退出，退出后再恢复；期间不能让这些 false 落盘。
 */
const shutSwitches = new Map<string, () => void>()

/** 登记重载方案。模块清单由入口持有，调度层不应重复维护一份。 */
export function registerReloadPlan(plan: ReloadPlan): void {
  reloadPlan = plan
}

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
  const startGeneration = generation

  // 同一代次内不允许重入；重载后的新一代可以重新跑，旧的一轮无法中断
  if (running.get(name) === startGeneration) {
    return
  }

  running.set(name, startGeneration)

  try {
    await instance.run()
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    logger.error(`模块 ${name} 运行出错：${failure.message}`)

    if (error instanceof ModuleCriticalError && startGeneration === generation) {
      criticalError = failure
    }
  } finally {
    if (running.get(name) === startGeneration) {
      running.delete(name)
    }

    if (startGeneration === generation) {
      scheduleFallback(name, instance)
    } else {
      retireInstance(name, instance)
    }
  }
}

/**
 * 临时关掉在途任务的开关，让它在这个检查点退出。
 *
 * 只改响应式对象的原始值：走 proxy 赋值会触发 store 的 deep watch（`leading: true`），
 * 把 `false` 立刻写进 storage.json。各模块读 `this.config.enabled` 时经由同一个 proxy，
 * 仍能拿到这里的改动。
 */
function shutDownInstance(name: string, instance: BaseModule): void {
  const config = (instance as any).config
  if (!config || typeof config !== 'object') {
    return
  }

  // 上一轮重载可能还没等到这个实例退出，先恢复旧值再记录本次的真值
  shutSwitches.get(name)?.()

  const raw = toRaw(config) as Record<string, any>
  const saved: Record<string, unknown> = {}

  // 点亮勋章任务不检查 enabled，点赞/弹幕循环只看各自的子开关
  for (const key of ['enabled', 'likeEnabled', 'danmuEnabled']) {
    if (key in raw) {
      saved[key] = raw[key]
      raw[key] = false
    }
  }

  if (Object.keys(saved).length === 0) {
    return
  }

  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      raw[key] = value
    }
    shutSwitches.delete(name)
    // toRaw 改动不触发 watch，主动落一次盘，避免重载期间其它配置变更把 false 带进文件
    Storage.setModuleConfig(useModuleStore().moduleConfig)
  }

  shutSwitches.set(name, restore)
}

/**
 * 重载后旧实例的收尾。
 *
 * 旧实例是重载那一刻正在跑的，开关被临时关掉、已在检查点退出：恢复开关后补一个新实例
 * 立即重新评估。今天已经完成的任务会被模块自己的完成标记挡掉，不会重复扣币或重复兑换。
 */
function retireInstance(name: string, instance: BaseModule): void {
  clearTimeout(instance.nextRunTimer)
  instance.nextRunTimer = undefined
  // 定时器回调是 `() => this.run()`，换掉 run 旧实例就不会再被唤醒
  instance.run = async () => {}

  shutSwitches.get(name)?.()

  const module = reloadPlan?.moduleMap[name]
  if (!module || !taskModuleNames.has(name)) {
    return
  }

  const fresh = new module(name)
  useModuleStore().moduleInstances[name] = fresh

  if (getCriticalError()) {
    // 默认模块未取到基础数据时不重跑任务，但仍要留排期，否则模块会永久退出调度
    scheduleFallback(name, fresh)
  } else if (fresh.isEnabled()) {
    logger.log(`模块 ${name} 已退出，按新配置重新运行`)
    void runModule(name, fresh)
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
  // 重复调用（重试、重载）时先撤掉旧的，避免多个看门狗同时触发同一模块
  if (watchdogTimer !== undefined) {
    clearInterval(watchdogTimer)
  }

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

/**
 * 清掉上一轮的调度状态。
 *
 * 先换代次再清标记：旧实例可能仍在运行，它们的收尾不会影响新一轮。
 */
function resetRunner(): void {
  generation += 1
  criticalError = undefined

  // running 不在这里清空：它记录的是「确实还有一轮在跑」，与代次无关，
  // 清掉会让看门狗把同一个模块再拉起一次
  if (watchdogTimer !== undefined) {
    clearInterval(watchdogTimer)
    watchdogTimer = undefined
  }
}

/**
 * 按启动流程跑一遍模块：默认模块串行完成后，任务模块并行启动。
 *
 * @param skip 本轮不启动的模块名（重载时正在运行的模块，避免同一任务并发执行）
 */
export async function startModules(skip: ReadonlySet<string> = new Set()): Promise<void> {
  const plan = reloadPlan
  if (!plan) {
    throw new Error('未登记模块清单')
  }

  registerTaskModules(plan.taskNames)

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
      // 不直接退出：cookie 失效一类的问题下，配置页面恰好是排查所需的入口
      logger.warn(`默认模块发生致命错误，本次不启动任务：${failure.message}`)
    } else {
      for (const name of plan.taskNames) {
        if (skip.has(name)) {
          logger.log(`模块 ${name} 开关已临时关闭，等这一轮退出后按新配置重新运行`)
          continue
        }

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

/**
 * 进程内重载：重读配置与 cookie，停掉现有排期后按启动流程重新运行。
 *
 * 不换进程，PID、终端归属、日志缓冲与配置页面连接都保持不变。在途任务无法从外部中断，
 * 只能临时关掉它们的开关，让循环在下一个检查点自行退出，退出后再按新配置重新评估。
 */
export async function reloadModules(): Promise<void> {
  const moduleStore = useModuleStore()

  const inFlight = new Set(running.keys())

  for (const [name, instance] of Object.entries(moduleStore.moduleInstances)) {
    if (inFlight.has(name)) {
      continue
    }

    clearTimeout(instance.nextRunTimer)
    instance.nextRunTimer = undefined
    // 定时器回调是 `() => this.run()`，换掉 run 旧实例就不会再被唤醒
    instance.run = async () => {}
  }

  resetRunner()

  // 配置文件与 cookie 都可能被外部改过
  storage.reload()
  resetCookieCache()

  // 就地覆盖，模块与 store 持有的引用继续有效
  overwriteConfig(moduleStore.moduleConfig, Storage.getModuleConfig())

  const logLevel = storage.get<LogLevel>('logLevel', options.logLevel)
  if (isLogLevel(logLevel)) {
    setLogLevel(logLevel)
  }

  // 覆盖之后才关开关，否则会被磁盘里的原值重新打开
  let shutCount = 0
  for (const [name, instance] of Object.entries(moduleStore.moduleInstances)) {
    if (!inFlight.has(name) || !running.has(name)) {
      continue
    }

    shutDownInstance(name, instance)
    if (shutSwitches.has(name)) {
      shutCount += 1
    }
  }

  if (shutCount > 0) {
    logger.log(`已临时关闭 ${shutCount} 项在途任务的开关，等它们退出后按新配置重新运行`)
  }

  logger.log('已重新读取配置，开始重新调度')
  await startModules(inFlight)
}
