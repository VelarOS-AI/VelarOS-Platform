/**
 * 可移植数据入口（`@velaros-ai/model/contracts`）：常量表（身份、provider 清单、错误码、
 * 环境变量表、公开上限）与经宿主端口、内核能力面、产品配置流动的全部数据类型。
 * 没有任何 Node 依赖，浏览器、渲染进程都能 import。
 */
export * from './contract/constants.js'
export type { ModelDriverLimits, ModelImage, ModelInputEstimate, ModelMaterial, ModelResponseFormat, ModelTurnDelta,ModelTurnRequest } from './types/driver.js'
export type * from './types/model'
export type { ProviderModelDefinition, SharedProviderCatalog } from './types/providers'
