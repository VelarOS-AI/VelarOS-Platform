/**
 * 可移植数据入口（`@velaros-ai/project/contracts`）：常量表（工具与 mod 身份、错误原因、工具排位、各工具上限、内核缺省策略、宿主代码查询的语言服务动作）
 * 和经过宿主端口流动的数据类型，以及 `velar:project`、`velar:code` 随包发布的模型面（模块名、方法、生成的完整声明）。没有任何 Node 依赖，浏览器、渲染进程都能 import。宿主端口本身是注入面，从根入口取。
 */
export * from './contract/constants.js'
export { VelarCodeModule, VelarProjectModule } from './contract/surface.js'
export type * from './types/project.js'
