/**
 * 可移植的系统空间能力契约。
 *
 * 运行时工具、进程访问、文件系统访问与平台探测仍由职责子路径提供；此入口只包含
 * 可跨进程消费的数据类型与 canonical 工具身份。
 */
export type { SystemToolCategoryId, SystemToolName } from './system-tool-names.js'
export { SystemToolCategoryByName, SystemToolNames } from './system-tool-names.js'
export type * from './SystemContracts.js'
