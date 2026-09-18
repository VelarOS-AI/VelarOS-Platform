/**
 * 产品面：本包交给外面的两件能力。API 定义在各自的类上方（`impl/` 里，接口紧挨着类），这里登记并转发；根入口按这里导出。
 */

export type { PlatformCompatibilityApi } from '../impl/PlatformCompatibility.js'
export type { VelarOSSharedResourcesApi } from '../impl/VelarOSSharedResources.js'
