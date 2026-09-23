/**
 * 带 Node 类型的选项数据：兼容层按哪个平台、哪份环境变量回答，shell 启动规格与应用数据目录的选项，共享资源目录的解析选项。
 * 只放数据；带行为的接口在各自的类上方（`impl/`），由 `contract/provides.ts` 登记。
 */

import type { RuntimePlatform, ShellKind } from './platform.js'

/** 创建兼容层实例的选项：按哪个平台、哪份环境变量回答；缺省取当前进程的。 */
export interface PlatformCompatibilityOptions {
  env?: NodeJS.ProcessEnv
  platform?: RuntimePlatform
}

/** 生成 shell 命令规格、给参数加引号时的选项：指定 shell 路径或种类，缺省按默认 shell。 */
export interface ShellCommandSpecOptions extends PlatformCompatibilityOptions {
  shellPath?: string
  kind?: ShellKind
}

/** 算应用数据目录时的选项：家目录缺省不给，那时只返回相对的应用名。 */
export interface DefaultAppDataPathOptions extends PlatformCompatibilityOptions {
  homeDir?: string
}

/** 解析 VelarOS 共享资源目录的选项：平台、环境变量、家目录，缺省取当前进程与当前用户的。 */
export interface VelarOSSharedResourceStoreOptions {
  platform?: RuntimePlatform
  env?: NodeJS.ProcessEnv
  homeDirectory?: string
}

/** 判断路径文本包含关系时的选项：缺省按平台惯例比大小写（Windows、macOS 不区分，其他区分）；已经用真实路径解开、要求逐字相等时传 caseSensitive: true。 */
export interface PathTextContainmentOptions {
  caseSensitive?: boolean
}
