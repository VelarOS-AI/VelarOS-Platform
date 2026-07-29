export type WorkspaceCliCommand =
  | 'help'
  | 'status'
  | 'read'
  | 'search'
  | 'symbols'
  | 'resolve'
  | 'prepare-edit'
  | 'commit-edit'
  | 'apply'
  | 'validate'
  | 'diff'
  | 'rollback'
  | 'journal'
  | 'tools.list'
  | 'tools.call'
  | 'tools.workflow'

export type WorkspaceCliStatus = 'ok' | 'error'

export const WorkspaceCliSchemaVersion = 1

/** 表示 workspace 命令行解析或执行阶段产生的稳定错误。 */
export class WorkspaceCliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 1,
    public readonly details: Record<string, any> = {}
  ) {
    super(message)
    this.name = 'WorkspaceCliError'
  }
}

export interface WorkspaceCliRequest<TArgs extends Record<string, any> = Record<string, any>> {
  command: WorkspaceCliCommand
  json: boolean
  cwd: Nullable<string>
  args: TArgs
}

export interface WorkspaceCliSuccessEnvelope {
  schemaVersion: 1
  kind: string
  status: Extract<WorkspaceCliStatus, 'ok'>
  workspaceRoot: string
  durationMs: number
  result: any
}

export interface WorkspaceCliErrorEnvelope {
  schemaVersion: 1
  kind: 'velaros.workspaceCli.error'
  status: Extract<WorkspaceCliStatus, 'error'>
  error: {
    code: string
    message: string
    details: Record<string, any>
  }
}

export interface WorkspaceCliRunResult {
  envelope: WorkspaceCliSuccessEnvelope | WorkspaceCliErrorEnvelope
  text: string
  exitCode: number
}

export interface WorkspaceCliWorkflowStep {
  id: string
  tool: string
  args?: Record<string, any>
}
