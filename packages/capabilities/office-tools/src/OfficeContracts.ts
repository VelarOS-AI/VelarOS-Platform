export interface OfficeWorkspaceMutationAuthorizationInput {
  cwd?: string
  operation: string
  targetPath?: string | null
  activate?: boolean
}

export interface OfficeWorkspaceAuthorizationDecision {
  approved: boolean
  rootPath: string
  switched: boolean
  alreadyAuthorized: boolean
  rejectionMessage: string | null
  message: string
  deferred?: boolean
  workspaceAutoApprovalNotice?: {
    id: string
    path: string
    reason: string
    action: 'add' | 'mutation'
    message: string
    approvedAt: number
  }
  autoApproved?: boolean
  authorizationScope?: 'operation' | 'workspace'
}

export interface OfficeEnvironmentCommandAvailability {
  name: string
  available: boolean
  path: string | null
}

/**
 * Host runtime platform understood by Office adapters.
 *
 * Known values remain discoverable in editors while the open string member
 * keeps third-party and future runtimes structurally compatible. This public
 * contract intentionally does not depend on Node.js ambient types.
 */
export type OfficeRuntimePlatform =
  | 'aix'
  | 'android'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'openbsd'
  | 'sunos'
  | 'win32'
  | (string & {})

export interface OfficeEnvironmentInspection {
  os: { platform: OfficeRuntimePlatform; arch: string; release: string; homeDir: string }
  shell: { path: string; variableCount: number; pathEntries: string[] }
  workspace: {
    systemWorkspaceRoot: string | null
    activeRoot: string | null
    configuredRoots: Array<{
      path: string
      active: boolean
      exists: boolean
      removable: boolean
      source: string
    }>
    activeConfiguredRoot: string | null
  }
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
  installCommand: string | null
  installAvailable: boolean
  detectedAt: number
  triggeredBy: { scope: 'workspace' | 'system'; command: string }
  alternatives?: OfficeSystemToolInstallAlternative[]
}

export interface OfficeSystemCommandResult {
  command: string
  cwd: string
  exitCode: number | null
  signal: string | null
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
  systemToolSuggestion?: OfficeSystemToolInstallSuggestion | null
}
