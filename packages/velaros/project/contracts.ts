/**
 * 可移植数据入口（`@velaros-ai/velaros/project/contracts`）：常量表（版本、错误原因、读写与代码查询的上限、内核缺省策略、宿主代码查询的语言服务动作）
 * 和宿主代码查询的数据类型，以及 `velaros:project`、`velaros:code` 随包发布的模型面（模块名、方法、生成的完整声明）。没有任何 Node 依赖，浏览器、渲染进程都能 import。空间端口本身是注入面，从根入口取。
 */
export * from './contract/constants.js'
export { VelarCodeModule, VelarProjectModule } from './contract/surface.js'
export type {
  ProjectSnapshotCapture,
  ProjectSnapshotEntry,
  ProjectSnapshotFile,
  ProjectSnapshotInput,
} from './types/observation.js'
export type * from './types/project.js'
