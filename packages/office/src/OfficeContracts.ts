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
