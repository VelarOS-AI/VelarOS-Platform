/**
 * 可移植数据入口（`@velaros-ai/velaros/shell/contracts`）：审批操作身份、shell 种类词表与公开上限，
 * 以及命令分类、并发判定、`velaros:shell` 入参与回执、宿主端口上流动的命令数据。还有 `velaros:shell` 随包发布的模型面（`VelarShellModule`），空间挂它时交给代码面的门。没有任何 Node 依赖，浏览器、渲染进程都能 import。
 */
export * from './contract/constants.js'
export { VelarShellModule } from './contract/surface.js'
export type * from './types/shell-command.js'
