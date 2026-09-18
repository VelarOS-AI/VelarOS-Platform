/**
 * 可移植数据入口（`@velaros-ai/velar/shell/contracts`）：审批操作身份、shell 种类词表与公开上限，
 * 以及命令分类、并发判定、`velar:shell` 入参与回执、宿主端口上流动的命令数据。没有任何 Node 依赖，浏览器、渲染进程都能 import。
 */
export * from './contract/constants.js'
export type * from './types/shell-command.js'
