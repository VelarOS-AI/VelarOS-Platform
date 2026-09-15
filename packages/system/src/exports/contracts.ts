/**
 * 可移植数据入口（`@velaros-ai/system/contracts`）：工具身份、错误码、环境变量表，以及经过宿主端口流动的全部数据结构。
 * 没有任何 Node 依赖，浏览器、渲染进程都能 import。宿主端口本身是注入面，从根入口取。
 */
export type * from '../contract/system.js'
export {
  SystemEnvironmentVariables,
  SystemErrorCodes,
  SystemModId,
  SystemSpaceId,
  SystemToolCategoryByName,
  SystemToolNames,
} from '../contract/system.js'
