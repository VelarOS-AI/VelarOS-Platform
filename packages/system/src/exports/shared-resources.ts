/** 共享资源目录入口（`@velaros-ai/system/shared-resources`）：VelarOS 产品家族共用的数据、资源、账号会话放在哪。只给 Node 用。 */
export type { VelarOSSharedResourceStoreOptions } from '../contract/platform.js'
export { velarosSharedResources } from '../impl/VelarOSSharedResources.js'
export type { VelarOSSharedResourcesApi } from '../interface/provides.js'
