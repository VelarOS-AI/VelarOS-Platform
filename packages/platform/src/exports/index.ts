/**
 * 平台约定根入口（`@velaros-ai/platform`）：跨平台兼容层与它用到的数据。不碰 Node 模块，渲染进程也能 import。
 * 共享资源目录只给 Node 用，在 `./shared-resources`；可移植数据单独在 `./contracts`。
 */

export type { PlatformCompatibilityApi } from '../impl/PlatformCompatibility.js'
export { createPlatform, currentPlatform } from '../impl/PlatformCompatibility.js'
export type { VelarOSSharedResourcesApi } from '../impl/VelarOSSharedResources.js'
export type { DefaultAppDataPathOptions, PlatformCompatibilityOptions, ShellCommandSpecOptions, VelarOSSharedResourceStoreOptions } from '../types/options.js'
export * from './contracts.js'
