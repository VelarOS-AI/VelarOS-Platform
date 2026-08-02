import { isNull, isString, isUndefined } from '@velaros-ai/core'

/**
 * 项目空间拥有的 Agent 能力面。宿主注入实现，参数结构与校验留在项目领域内；
 * 返回契约只包含 Agent 编排读取和事务编辑时真正观察的字段。
 */

export interface AgentProjectCommandToolRequirement {
  kind: string
  command: string
  reason?: string
}

export interface AgentProjectDiagnostic {
  severity: 'info' | 'warning' | 'error'
  message: string
  path?: string
  line?: number
  column?: number
  source?: string
  data?: unknown
}

export interface AgentProjectPreparedPatch {
  path: string
  diff: string
  changedLines: number
}

export interface AgentProjectPreparedTransaction {
  transactionId: string
  patches: AgentProjectPreparedPatch[]
  changedFiles: string[]
  diff: string
  changedLines: number
  risk: 'low' | 'medium' | 'high'
  createdAt: number
}

export interface AgentProjectApplyResult {
  transactionId: string
  changedFiles: string[]
  oldRevisions: Record<string, string>
  newRevisions: Record<string, string>
  rebasedFiles?: string[]
  gitTrackedFiles?: string[]
}

export interface AgentProjectValidationResult {
  ok: boolean
  diagnostics: AgentProjectDiagnostic[]
  checks: Array<{
    id: string
    ok: boolean
    diagnostics?: AgentProjectDiagnostic[]
    metadata?: unknown
  }>
  toolRequirements?: AgentProjectCommandToolRequirement[]
}

export interface AgentProjectFixResult {
  ok: boolean
  changed: boolean
  transactionId: string
  changedFiles: string[]
  fixes: Array<{
    path: string
    content: string
    source: string
  }>
  diagnostics: AgentProjectDiagnostic[]
  toolRequirements?: AgentProjectCommandToolRequirement[]
}

export interface AgentProjectFileSnapshot {
  exists: boolean
  isDirectory: boolean
  isBinary: boolean
  revision?: string
}

export interface AgentProjectReadResult {
  snapshot: AgentProjectFileSnapshot
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

export interface AgentProjectSearchResult {
  query: string
  hits: Array<{ path: string }>
  truncated?: boolean
  toolRequirements?: AgentProjectCommandToolRequirement[]
}

export interface AgentProjectDiffResult {
  diff: string
  changedFiles: string[]
  changedLines: number
}

export type AgentProjectResolveTargetResult =
  | {
      status: 'resolved'
      target: {
        range?: { startLine?: number; endLine?: number }
      }
    }
  | {
      status: 'ambiguous' | 'not_found'
    }

export interface AgentProjectKernelPort {
  listFiles(input?: any): Promise<Array<{ path: string; type: 'file' | 'directory' }>>
  stat(input: any): Promise<unknown>
  read(input: any): Promise<AgentProjectReadResult>
  search(input: any): Promise<AgentProjectSearchResult>
  listSymbols(path: string): Promise<any[]>
  resolveTarget(input: any): Promise<AgentProjectResolveTargetResult>
  prepareEdit(input: any): Promise<AgentProjectPreparedTransaction>
  discardTransaction(transactionId: string): { discarded: boolean }
  getTransaction(
    transactionId: string
  ): AgentProjectPreparedTransaction | undefined
  fixTransaction(input: any): Promise<AgentProjectFixResult>
  applyEdit(input: any): Promise<AgentProjectApplyResult>
  validate(input: any): Promise<AgentProjectValidationResult>
  rollback(input: any): Promise<unknown>
  diff(input?: any): Promise<AgentProjectDiffResult>
  status(): Promise<{ root: string; validators: string[] }>
}

export interface AgentProjectReadRequest {
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
    source: 'system' | 'user' | 'project' | 'tool' | 'external'
    trust: 'trusted' | 'untrusted'
  }
}

const DefaultAgentReadMaxChars = 500_000

/** Project-owned Agent adapter for multi-file aggregation over the injected read port. */
export async function executeAgentProjectRead(
  project: AgentProjectKernelPort,
  input: AgentProjectReadRequest,
  options: { rootPath?: string } = {}
): Promise<{
  rootPath: string
  count: number
  files: AgentProjectReadResult[]
  appliedDefaultBound?: { maxChars: number }
}> {
  const {
    path,
    baseRevisions,
    allowUnbounded: _allowUnbounded,
    ...rest
  } = input
  const paths = isString(path) ? [path] : path
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
      project.read({
        ...readInput,
        path: filePath,
        baseRevision: baseRevisions?.[filePath],
      })
    )
  )
  const rootPath = options.rootPath ?? (await project.status()).root
  return {
    rootPath,
    count: files.length,
    files,
    ...(appliedDefaultBound
      ? { appliedDefaultBound: { maxChars: DefaultAgentReadMaxChars } }
      : {}),
  }
}

export interface AgentProjectErrorLike extends Error {
  reason: string
  details?: unknown
  suggestedNextAction?: string
}

export function isAgentProjectError(
  error: unknown,
  reason?: string
): error is AgentProjectErrorLike {
  if (!(error instanceof Error)) return false
  const candidate = error as Error & {
    reason?: unknown
    suggestedNextAction?: unknown
  }
  if (!isString(candidate.reason)) return false
  return isUndefined(reason) || candidate.reason === reason
}

/** JSON-safe error projection exported by the Project Agent adapter. */
export function toAgentProjectErrorObject(
  error: unknown
): Record<string, unknown> {
  if (isAgentProjectError(error)) return {
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
  if (isNull(error)) return {
      name: 'NullError',
      message: '预期错误对象，但收到或抛出了 null。',
    }
  if (isUndefined(error)) return {
      name: 'UndefinedError',
      message: '预期错误对象，但收到或抛出了 undefined。',
    }
  return { message: String(error) }
}
