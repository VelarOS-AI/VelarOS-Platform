/**
 * 经宿主端口流动的数据，随 `./contracts` 入口出包：授权请求与决定、环境探测、命令结果、
 * 原生命令、产物回执、MarkItDown 定位结果。不 import、不带行为、不用 Node 专属类型。
 */

export interface OfficeProjectMutationAuthorizationInput {
  cwd?: string
  operation: string
  targetPath?: LooseOptional<string>
  activate?: boolean
}

export interface OfficeProjectAuthorizationDecision {
  approved: boolean
  rootPath: string
  switched: boolean
  alreadyAuthorized: boolean
  rejectionMessage: Nullable<string>
  message: string
  deferred?: boolean
  projectAutoApprovalNotice?: {
    id: string
    path: string
    reason: string
    action: 'add' | 'mutation'
    message: string
    approvedAt: number
  }
  autoApproved?: boolean
  authorizationScope?: 'operation' | 'project'
}

export interface OfficeEnvironmentCommandAvailability {
  name: string
  available: boolean
  path: Nullable<string>
}

export interface OfficeEnvironmentInspection {
  commands: OfficeEnvironmentCommandAvailability[]
}

export interface OfficeSystemToolInstallAlternative {
  id: string
  label: { 'zh-CN': string; 'en-US': string }
  description: { 'zh-CN': string; 'en-US': string }
  draft: { 'zh-CN': string; 'en-US': string }
}

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
