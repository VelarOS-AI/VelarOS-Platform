/**
 * 可移植数据入口（`@velaros-ai/tool-contract/contracts`）：canonical 工具 id 的写法、失败回执的结论与上限、
 * 各空间共用的约束句，以及一条工具对外声明的那些数据形状。
 * 没有任何 Node 依赖，浏览器、渲染进程都能 import。
 */
export * from './contract/constants.js'
export type * from './types/tool-contract.js'
