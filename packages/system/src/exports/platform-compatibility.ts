/**
 * 跨平台兼容层入口（`@velaros-ai/system/platform-compatibility`）：路径文本、shell、进程命令、应用与数据目录约定，按平台给统一答案。
 * 不碰 Node 模块，渲染进程也能用。
 */
export type {
  BackgroundShellLaunchOptions,
  CommandSpec,
  DefaultAppDataPathOptions,
  DirectorySymlinkType,
  EditorCommandDefinition,
  PathTextSeparator,
  RuntimePlatform,
  ShellCommandSpecOptions,
  SystemPlatformCompatibilityOptions,
} from '../contract/platform.js'
export { createSystemPlatform, currentSystemPlatform } from '../impl/SystemPlatformCompatibility.js'
export type { SystemPlatformCompatibilityApi } from '../interface/provides.js'
