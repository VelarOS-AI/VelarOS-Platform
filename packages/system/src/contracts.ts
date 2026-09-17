/**
 * 可移植数据入口（`@velaros-ai/system/contracts`）：常量表（错误码、环境变量表）和本地内核给宿主界面的可移植数据。
 * 没有任何 Node 依赖，浏览器、渲染进程都能 import。宿主端口本身是注入面，从根入口取。
 */
export * from './contract/constants.js'
export type * from './types/system.js'
