/**
 * 可移植数据入口（`@velaros-ai/velaros/office/contracts`）：常量表（错误码、环境变量表、上限、MarkItDown 认的扩展名）、
 * `velaros:office` 的入参与回执、经空间端口流动的全部数据类型（都在 `types/office.ts`）；还有随包发布的模型面（`VelarOfficeModule`：模块名、方法、生成的完整声明），
 * 空间挂它时交给代码面的门。
 *
 * 没有任何 Node 依赖——浏览器、渲染进程与 IPC 契约都能 import。文档生成、转换与渲染的实现由根入口提供。
 */
export * from './contract/constants.js'
export { VelarOfficeModule } from './contract/surface.js'
export type * from './types/office.js'
