/**
 * Workspace-owned agent capability surface. Hosts inject an implementation; Kernel does not own these contracts.
 *
 * Inputs remain opaque because their schemas and validation belong to the
 * injected Workspace module. Result shapes include only fields Agent actually
 * observes while orchestrating reads and transactional edits.
 */

export interface AgentWorkspaceCommandToolRequirement {
  kind: string
  command: string
  reason?: string
}

export interface AgentWorkspaceDiagnostic {
  severity: 'info' | 'warning' | 'error'
  message: string
  path?: string
  line?: number
  column?: number
  source?: string
  data?: unknown
}

export interface AgentWorkspacePreparedPatch {
  path: string
  diff: string
  changedLines: number
}

export interface AgentWorkspacePreparedTransaction {
  transactionId: string
  patches: AgentWorkspacePreparedPatch[]
  changedFiles: string[]
  diff: string
  changedLines: number
  risk: 'low' | 'medium' | 'high'
  createdAt: number
}

export interface AgentWorkspaceApplyResult {
  transactionId: string
  changedFiles: string[]
  oldRevisions: Record<string, string>
  newRevisions: Record<string, string>
  rebasedFiles?: string[]
  gitTrackedFiles?: string[]
}

export interface AgentWorkspaceValidationResult {
  ok: boolean
  diagnostics: AgentWorkspaceDiagnostic[]
  checks: Array<{
    id: string
    ok: boolean
    diagnostics?: AgentWorkspaceDiagnostic[]
    metadata?: unknown
  }>
  toolRequirements?: AgentWorkspaceCommandToolRequirement[]
}

export interface AgentWorkspaceFixResult {
  ok: boolean
  changed: boolean
  transactionId: string
  changedFiles: string[]
  fixes: Array<{
    path: string
    content: string
    source: string
  }>
  diagnostics: AgentWorkspaceDiagnostic[]
  toolRequirements?: AgentWorkspaceCommandToolRequirement[]
}

export interface AgentWorkspaceFileSnapshot {
  exists: boolean
  isDirectory: boolean
  isBinary: boolean
  revision?: string
}

export interface AgentWorkspaceReadResult {
  snapshot: AgentWorkspaceFileSnapshot
  content?: string
  range?: {
    startLine: number
    endLine: number
    startColumn?: number
    endColumn?: number
    startOffset?: number
    endOffset?: number
  }
  totalLines?: number
  truncated?: boolean
  nextStartLine?: number
  remainingLines?: number
  hasMore?: boolean
}

export interface AgentWorkspaceSearchResult {
  query: string
  hits: Array<{ path: string }>
  truncated?: boolean
  toolRequirements?: AgentWorkspaceCommandToolRequirement[]
}

export interface AgentWorkspaceDiffResult {
  diff: string
  changedFiles: string[]
  changedLines: number
}

export type AgentWorkspaceResolveTargetResult =
  | {
      status: 'resolved'
      target: {
        range?: { startLine?: number; endLine?: number }
      }
    }
  | {
      status: 'ambiguous' | 'not_found'
    }

export interface AgentWorkspaceKernelPort {
  listFiles(input?: any): Promise<Array<{ path: string; type: 'file' | 'directory' }>>
  stat(input: any): Promise<unknown>
  read(input: any): Promise<AgentWorkspaceReadResult>
  search(input: any): Promise<AgentWorkspaceSearchResult>
  listSymbols(path: string): Promise<any[]>
  resolveTarget(input: any): Promise<AgentWorkspaceResolveTargetResult>
  prepareEdit(input: any): Promise<AgentWorkspacePreparedTransaction>
  getTransaction(
    transactionId: string
  ): AgentWorkspacePreparedTransaction | undefined
  fixTransaction(input: any): Promise<AgentWorkspaceFixResult>
  applyEdit(input: any): Promise<AgentWorkspaceApplyResult>
  validate(input: any): Promise<AgentWorkspaceValidationResult>
  rollback(input: any): Promise<unknown>
  diff(input?: any): Promise<AgentWorkspaceDiffResult>
  status(): Promise<{ root: string; validators: string[] }>
}

export interface AgentWorkspaceReadRequest {
  path: string | string[]
  range?: {
    startLine?: number
    endLine?: number
    startColumn?: number
    endColumn?: number
    startOffset?: number
    endOffset?: number
  }
  maxBytes?: number
  maxChars?: number
  allowUnbounded?: boolean
  baseRevisions?: Record<string, string>
  trust?: {
    source: 'system' | 'user' | 'workspace' | 'tool' | 'external'
    trust: 'trusted' | 'untrusted'
  }
}

const DefaultAgentReadMaxChars = 500_000

/** Workspace-owned Agent adapter for multi-file aggregation over the injected read port. */
export async function executeAgentWorkspaceRead(
  workspace: AgentWorkspaceKernelPort,
  input: AgentWorkspaceReadRequest,
  options: { rootPath?: string } = {}
): Promise<{
  rootPath: string
  count: number
  files: AgentWorkspaceReadResult[]
  appliedDefaultBound?: { maxChars: number }
}> {
  const {
    path,
    baseRevisions,
    allowUnbounded: _allowUnbounded,
    ...rest
  } = input
  const paths = typeof path === 'string' ? [path] : path
  const appliedDefaultBound = !(
    input.range?.endLine
    || input.maxBytes
    || input.maxChars
    || input.allowUnbounded
  )
  const readInput =
    appliedDefaultBound
    || (input.allowUnbounded && !input.maxBytes && !input.maxChars)
      ? { ...rest, maxChars: DefaultAgentReadMaxChars }
      : rest
  const files = await Promise.all(
    paths.map((filePath) =>
      workspace.read({
        ...readInput,
        path: filePath,
        baseRevision: baseRevisions?.[filePath],
      })
    )
  )
  const rootPath = options.rootPath ?? (await workspace.status()).root
  return {
    rootPath,
    count: files.length,
    files,
    ...(appliedDefaultBound
      ? { appliedDefaultBound: { maxChars: DefaultAgentReadMaxChars } }
      : {}),
  }
}

export interface AgentWorkspaceErrorLike extends Error {
  reason: string
  details?: unknown
  suggestedNextAction?: string
}

export function isAgentWorkspaceError(
  error: unknown,
  reason?: string
): error is AgentWorkspaceErrorLike {
  if (!(error instanceof Error)) return false
  const candidate = error as Error & {
    reason?: unknown
    suggestedNextAction?: unknown
  }
  if (typeof candidate.reason !== 'string') return false
  return reason === undefined || candidate.reason === reason
}

/** JSON-safe error projection exported by the Workspace Agent adapter. */
export function toAgentWorkspaceErrorObject(
  error: unknown
): Record<string, unknown> {
  if (isAgentWorkspaceError(error)) return {
      name: error.name,
      reason: error.reason,
      message: error.message,
      details: error.details,
      suggestedNextAction: error.suggestedNextAction,
    }
  if (error instanceof Error) return {
      name: error.name,
      message: error.message,
    }
  if (error === null) return {
      name: 'NullError',
      message: '预期错误对象，但收到或抛出了 null。',
    }
  if (error === undefined) return {
      name: 'UndefinedError',
      message: '预期错误对象，但收到或抛出了 undefined。',
    }
  return { message: String(error) }
}
