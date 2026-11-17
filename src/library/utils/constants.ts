/**
 * 无依赖的零散常量
 *
 * 从 `utils/index.ts` 拆出来：该文件值导入了 stores，会牵出仅用户脚本环境可用的
 * `$` 虚拟模块，独立运行版的页面构建无法解析。
 */

/** 粉丝勋章面板里「账号已注销」用户的昵称 */
export const CANCELLED_NICK_NAME = '账号已注销'

interface NumberSetting {
  min: number
  max: number
  default: number
  integer: boolean
}

/**
 * 观看直播数值设置的唯一范围定义。
 *
 * 输入控件、参数校验与配置归一化都从这里取值，避免同一项在多个位置各写一份上下限。
 */
export const SETTING_RANGES = {
  watchTime: { min: 5, max: 180, default: 25, integer: true },
  watchRestartDelay: { min: 5, max: 180, default: 5, integer: true },
} satisfies Record<string, NumberSetting>

/** 把配置值夹到设置范围内；非法值退回默认值 */
export function normalizeSetting(value: unknown, setting: NumberSetting): number {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return setting.default
  }
  const clamped = Math.min(setting.max, Math.max(setting.min, number))
  return setting.integer ? Math.floor(clamped) : clamped
}
