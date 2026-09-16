/** 构造与依赖注入的兼容名称；场景请求由对应产品 owner 使用通用客户端组合。 */
export type { ModelRequestClientOptions } from './ModelRequestClient'
export { ModelRequestClient } from './ModelRequestClient'
/** @deprecated 使用 ModelRequestClient。 */
export { ModelRequestClient as ModelRequestService } from './ModelRequestClient'
/** @deprecated 使用 ModelRequestClientOptions。 */
export type { ModelRequestClientOptions as ModelRequestServiceOptions } from './ModelRequestClient'
