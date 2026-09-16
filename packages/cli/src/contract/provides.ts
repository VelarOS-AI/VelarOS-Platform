/**
 * 产品面：本包交给外面的两件能力——命令行路由器与进程壳。
 * 它们的 API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发；根入口按这里导出。
 */

// ── 类实现的产品面接口：定义在类上方，这里登记 ────────────────
export type { VelarosCliProcessApi, VelarosCliProcessContext } from '../impl/VelarosCliProcess.js'
export type { VelarosCliRouterApi, VelarosCliRouterOptions } from '../impl/VelarosCliRouter.js'
