/**
 * 可移植数据入口（`@velaros-ai/velaros/computer/contracts`）：常量表（helper 资产的版本与布局、错误码、环境变量表、上限）、
 * `velaros:computer` 的入参与回执，以及经宿主端口流动的数据类型；还有随包发布的模型面（`VelarComputerModule`：模块名、方法、生成的完整声明），
 * 空间挂它时交给代码面的门。没有任何 Node 依赖，浏览器、渲染进程都能 import。
 */
export * from './contract/constants.js'
export { VelarComputerModule } from './contract/surface.js'
export type * from './types/computer.js'
