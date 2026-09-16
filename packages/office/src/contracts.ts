/**
 * 可移植数据入口（`@velaros-ai/office/contracts`）：常量表（工具身份、错误码、环境变量表、上限）
 * 和经宿主端口流动的全部数据类型。没有任何 Node 依赖，浏览器、渲染进程都能 import。
 */
export * from './contract/constants.js'
export type { OfficeToolPermission, VelaTool } from './contract/provides.js'
export type { OfficeHostApi, OfficeToolContext } from './contract/requires.js'
export type * from './types/office.js'
