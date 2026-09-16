/**
 * 经宿主端口流动的数据，随 `./contracts` 入口出包：授权请求与决定、环境探测、命令结果、
 * 原生命令、产物回执、MarkItDown 定位结果。不 import、不带行为、不用 Node 专属类型。
 */

/** 向宿主申请一次写入授权：这次要做什么、目标是哪条路径。 */
export interface OfficeMutationRequest {
  cwd?: string
  operation: string
  targetPath?: LooseOptional<string>
}

/** 宿主的授权裁决：批不批、以哪个根为准、被拒时怎么跟用户说。 */
export interface OfficeMutationDecision {
  approved: boolean
  rootPath: string
  rejectionMessage: Nullable<string>
  message: string
}

export interface OfficeEnvironmentCommandAvailability {
  name: string
  available: boolean
  path: Nullable<string>
}

export interface OfficeEnvironmentInspection {
  commands: OfficeEnvironmentCommandAvailability[]
}

/**
 * 安装建议卡上的一个替代方案。
 *
 * @deprecated 安装建议与替代方案已经搬回宿主：office 只返回 `OfficeErrorCodes.converterMissing`
 * 与缺哪个命令、为什么要它，卡片的文案、按钮与用户草稿由宿主自己拼。名字只为兼容保留。
 */
export interface OfficeSystemToolInstallAlternative {
  id: string
  label: { 'zh-CN': string; 'en-US': string }
  description: { 'zh-CN': string; 'en-US': string }
  draft: { 'zh-CN': string; 'en-US': string }
}

/**
 * 宿主生成的安装建议卡。
 *
 * @deprecated 同上，已搬回宿主；本包不再构造也不再读它，只在命令结果里原样透传。
 */
export interface OfficeSystemToolInstallSuggestion {
  id: string
  toolId: string
  label: string
  command: string
  packageName: string
  reason: string
  installCommand: Nullable<string>
  installAvailable: boolean
  detectedAt: number
  triggeredBy: { scope: 'project' | 'system'; command: string }
  alternatives?: OfficeSystemToolInstallAlternative[]
}

export interface OfficeSystemCommandResult {
  command: string
  cwd: string
  exitCode: Nullable<number>
  signal: Nullable<string>
  stdout: string
  stderr: string
  logPath?: string
  durationMs: number
  timedOut: boolean
  aborted: boolean
  truncated: boolean
  success: boolean
  backgroundProcess?: unknown
  verification: {
    kind: 'build' | 'lint' | 'test' | 'typecheck' | 'unknown'
    status: 'aborted' | 'failed' | 'passed' | 'timed-out' | 'unknown'
    issues: string[]
  }
  systemToolSuggestion?: LooseOptional<OfficeSystemToolInstallSuggestion>
}

/** 跑一条外部命令的选项：在哪跑、给多久、收多少输出，以及给审批与日志看的可读描述。 */
export interface OfficeCommandOptions {
  description: string
  cwd: string
  timeoutMs: number
  maxOutputChars: number
}

/** 交给宿主执行的原生命令：可执行文件、参数数组和额外环境变量，不经 shell 拼串。 */
export interface OfficeNativeCommand {
  file: string
  args: string[]
  env?: Record<string, string>
}

/** 已安装的 MarkItDown runtime：可执行文件、包根与版本号。 */
export interface MarkItDownLaunchSpec {
  command: string
  packageRoot: string
  version: string
}

/** 归一化后的 Word 输入：.docx 直接用，.doc 先转成临时 .docx，临时目录用完要回收。 */
export type NormalizedWordInput = {
  path: string
  originalPath: string
  sourceExtension: '.docx' | '.doc'
  convertedFromLegacyDoc: boolean
  tempDir: Nullable<string>
  converter?: string
  conversionCommandResult?: OfficeSystemCommandResult
}
