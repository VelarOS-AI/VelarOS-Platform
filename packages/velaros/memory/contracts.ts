/**
 * 可移植数据入口（`@velaros-ai/velaros/memory/contracts`）：四个类别与公开上限，`velaros:memory` 的入参与回执，管理页用的作用域概况。
 * 还有 `velaros:memory` 随包发布的模型面（`VelarMemoryModule`：模块名、方法、生成的完整声明与代码模版），空间挂它时交给代码面的门。
 * 没有任何 Node 依赖，浏览器、渲染进程都能 import。
 */
export * from './contract/constants.js'
export { VelarMemoryModule } from './contract/surface.js'
export type * from './types/memory.js'
