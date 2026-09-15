/**
 * 可移植数据入口（`@velaros-ai/system/contracts`）：常量表（工具身份、错误码、环境变量表、上限）和经过宿主端口流动的全部数据类型。
 * 没有任何 Node 依赖，浏览器、渲染进程都能 import。宿主端口本身是注入面，从根入口取。
 */
export * from '../contract/constants.js'
export type * from '../types/system.js'
