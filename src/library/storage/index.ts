import { GM_getValue, GM_setValue } from '$'
import defaultValues from './defaultValues'
import type { UiConfig, ModuleConfig, Cache, RoomidEntry } from '@/types'
import _ from 'lodash'

class Storage {
  /**
   * 递归合并配置项。删除当前配置中不存在于默认配置的键，补上相对于默认配置缺少的键值，其它键值不变
   *
   * 该方法不会修改当前配置
   *
   * @param currentConfig 当前配置
   * @param defaultConfig 默认配置
   * @returns 修改后的当前配置
   * @example
   *
   * const current_config = { enabled: true, details: { type: 'efg', status: 'ok' }, msg: 'hi' };
   * const default_config = { enabled: false, details: { type: 'abc', num: 1 } };
   *
   * mergeConfigs(current_config, default_config);
   * // => { enabled: true, details: { type: 'efg', num: 1 } }
   */
  private static mergeConfigs<T extends Record<string, any>>(
    currentConfig: Record<string, any>,
    defaultConfig: T,
  ): T {
    // 取出当前配置中存在于默认配置的键以及其所对应的值
    const config = _.pick(currentConfig, _.keys(defaultConfig))
    // 补上缺失的键值对
    _.defaults(config, defaultConfig)

    _.forOwn(config, (value, key, object) => {
      if (
        _.isPlainObject(value) &&
        _.isPlainObject(defaultConfig[key]) &&
        !_.isEmpty(defaultConfig[key])
      ) {
        // 如果都是普通对象且默认配置项不为空，递归合并子配置项
        object[key] = this.mergeConfigs(value, defaultConfig[key])
      }
    })

    return config as T
  }

  public static setUiConfig(uiConfig: UiConfig) {
    GM_setValue('ui', uiConfig)
  }

  public static getUiConfig(): UiConfig {
    return this.mergeConfigs(GM_getValue('ui', {}), defaultValues.ui)
  }

  /**
   * 归一化房间名单
   *
   * 旧配置中房间名单是 number[]（只有房间号），迁移为 {roomid, name}[]，用户名留空，
   * 运行时会按粉丝勋章数据自动更新；不合法的条目直接丢弃。
   *
   * @param list 存储中的原始名单
   */
  private static normalizeRoomidList(list: unknown): RoomidEntry[] {
    if (!Array.isArray(list)) {
      return []
    }
    const result: RoomidEntry[] = []
    for (const item of list) {
      if (typeof item === 'number') {
        result.push({ roomid: item, name: '' })
      } else if (_.isPlainObject(item)) {
        const entry = item as { roomid?: unknown; name?: unknown }
        if (typeof entry.roomid === 'number') {
          result.push({ roomid: entry.roomid, name: typeof entry.name === 'string' ? entry.name : '' })
        }
      }
    }
    return result
  }

  public static setModuleConfig(moduleConfig: ModuleConfig) {
    GM_setValue('modules', moduleConfig)
  }

  public static getModuleConfig(): ModuleConfig {
    const moduleConfig = this.mergeConfigs(GM_getValue('modules', {}), defaultValues.modules)
    const medalTasks = moduleConfig.DailyTasks.LiveTasks.medalTasks
    medalTasks.roomidList = this.normalizeRoomidList(medalTasks.roomidList)
    medalTasks.roomidList2 = this.normalizeRoomidList(medalTasks.roomidList2)
    return moduleConfig
  }

  public static setCache(cache: Cache) {
    GM_setValue('cache', cache)
  }

  public static getCache(): Cache {
    return this.mergeConfigs(GM_getValue('cache', {}), defaultValues.cache)
  }
}

export default Storage
