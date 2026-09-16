// 门面：`@velaros-ai/kernel/contracts` —— 可移植的契约数据与常量表。
//
// 这条入口不含任何实现，也不碰 Node 模块：渲染进程、浏览器打包、跨进程的 wire 数据都只认它。
// 需要值（造内核、写模块、起守护进程）的从根入口 `@velaros-ai/kernel` 取。
export * from './contract/constants'
export type * from './types/kernel.js'
