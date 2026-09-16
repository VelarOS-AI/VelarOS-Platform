/**
 * 常量表：provider 自持代理面（Agent Surface）线格式的约定值。
 * 不 import 任何东西，浏览器、渲染进程、扩展都能用（从 `@velaros-ai/surface-protocol/contracts` 取）。
 */

/** 线协议本身：版本冻结为 1，两端不商量；改线格式先升这里，旧版本一律拒收。 */
export const ProviderSurfaceProtocol = Object.freeze({
  /** 协议版本。目录、调用、回执三种载荷都带它，对不上就不是同一套协议。 */
  version: 1,
} as const)

/** 代理面能挂的工作区空间，与 VelarOS 的三个空间一一对应。 */
export const ProviderSurfaceWorkspaceSpaces = Object.freeze([
  'system',
  'project',
  'browser',
] as const)

/** 一次工具调用的三种结局：成功、执行出错、被权限挡下。 */
export const ProviderSurfaceToolResultStatuses = Object.freeze([
  'success',
  'error',
  'denied',
] as const)

/** 回执里允许携带的图片类型；二进制不进文本输出，由适配器走自己的附件通道上传。 */
export const ProviderSurfaceArtifactMediaTypes = Object.freeze([
  'image/png',
  'image/jpeg',
] as const)

/** 线格式的公开上限：两端按同一组数字校验，改一处两端一起变。 */
export const ProviderSurfaceLimits = Object.freeze({
  /** 一条工具回执最多带几个附件；再多就该走文件而不是内联 base64。 */
  artifactsPerResult: 4,
  /** 单个附件的 base64 字符数上限（32 MiB），超过就当越界拒收。 */
  artifactBase64Chars: 32 * 1024 * 1024,
  /** 单个附件文件名的字符数上限（255），对齐常见文件系统。 */
  artifactNameChars: 255,
  /** 单个附件 base64 的字符数下限（4）：少于一个 base64 分组的内容不是合法附件。 */
  artifactBase64MinChars: 4,
} as const)

/** 工作区空间的取值。 */
export type ProviderSurfaceWorkspaceSpace = (typeof ProviderSurfaceWorkspaceSpaces)[number]

/** 工具回执状态的取值。 */
export type ProviderSurfaceToolResultStatus = (typeof ProviderSurfaceToolResultStatuses)[number]

/** 附件图片类型的取值。 */
export type ProviderSurfaceArtifactMediaType = (typeof ProviderSurfaceArtifactMediaTypes)[number]
