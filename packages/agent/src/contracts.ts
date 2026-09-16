// `./contracts` 入口：可移植的契约数据与常量表，任何环境都能加载（渲染进程也能）。
// 它是根入口的可移植子集——只要数据不要值的调用方认它；拿值一律从根入口或 `./chat`、`./tool-contract` 取。
export * from './contract/constants.js'
export type * from './types/agent.js'
