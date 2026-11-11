/**
 * 无依赖的零散常量
 *
 * 从 `utils/index.ts` 拆出来：该文件值导入了 stores，会牵出仅用户脚本环境可用的
 * `$` 虚拟模块，独立运行版的页面构建无法解析。
 */

/** 粉丝勋章面板里「账号已注销」用户的昵称 */
export const CANCELLED_NICK_NAME = '账号已注销'
