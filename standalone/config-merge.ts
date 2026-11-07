/**
 * 就地覆盖配置对象。
 *
 * 各模块与 store 的 watch 都持有配置节点自身的引用，替换整个对象会让它们继续读旧数据，
 * 因此逐层改叶子值；source 中缺失的键按删除处理，删掉房间、弹幕之类的条目才会真正生效。
 */
export function overwriteConfig(target: any, source: Record<string, any>): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      delete target[key]
    }
  }

  for (const [key, value] of Object.entries(source)) {
    const current = target[key]
    if (isPlainObject(current) && isPlainObject(value)) {
      overwriteConfig(current, value)
    } else {
      target[key] = value
    }
  }
}

export function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
