/**
 * 可移植数据入口（`@velaros-ai/velar/knowledge/contracts`）：常量表（来源类型、公开上限）、`velar:knowledge` 的入参与回执，
 * 以及经空间端口流动的数据类型；还有随包发布的模型面（`VelarKnowledgeModule`：模块名、方法、生成的完整声明），
 * 空间挂它时交给代码面的门。没有任何 Node 依赖，浏览器、渲染进程都能 import。
 */
export * from './contract/constants.js'
export { VelarKnowledgeModule } from './contract/surface.js'
export type * from './types/knowledge.js'
